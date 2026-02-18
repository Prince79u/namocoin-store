 require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcrypt");
const multer = require("multer");
const fs = require("fs");

const { Rcon } = require("rcon-client"); // ✅ NEW

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Invoice email helpers (must exist)
const { sendMail } = require("./mailer");
const { invoiceHtml } = require("./invoice");

const app = express();

/* ---------------- Uploads Setup ---------------- */
const uploadsDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe =
      Date.now() + "-" + (file.originalname || "proof").replace(/\s+/g, "_");
    cb(null, safe);
  },
});
const upload = multer({ storage });

/* ---------------- Express Setup ---------------- */
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/uploads", express.static(uploadsDir));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---------------- Session Setup ---------------- */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 60 * 1000, // 30 minutes
    },
  })
);

/* ---------------- Login Attempt Limiter ---------------- */
const MAX_LOGIN_TRIES = 5;
const LOCK_MINUTES = 10;

function isLocked(req) {
  const until = req.session.loginLockUntil || 0;
  return Date.now() < until;
}
function recordFail(req) {
  req.session.loginTries = (req.session.loginTries || 0) + 1;
  if (req.session.loginTries >= MAX_LOGIN_TRIES) {
    req.session.loginLockUntil = Date.now() + LOCK_MINUTES * 60 * 1000;
    req.session.loginTries = 0;
  }
}
function clearFails(req) {
  req.session.loginTries = 0;
  req.session.loginLockUntil = 0;
}

/* ---------------- Helpers (AUTH) ---------------- */
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect("/admin/login");
  next();
}

/* ---------------- Settings: Conversion Rate ---------------- */
const DEFAULT_RATE = 9; // ✅ default: 1 INR = 9 NamoCoins
const BONUS_COINS = 10; // +10 on every pack except first
const FIRST_PACK_PRICE = 45;

async function getCoinRate() {
  const row = await prisma.setting.upsert({
    where: { key: "conversionRate" },
    update: {},
    create: { key: "conversionRate", intValue: DEFAULT_RATE },
  });
  return row.intValue || DEFAULT_RATE;
}

function calcCoins(priceINR, rate) {
  const base = Math.round(Number(priceINR) * Number(rate));
  const bonus = Number(priceINR) === FIRST_PACK_PRICE ? 0 : BONUS_COINS;
  return base + bonus;
}

/* ---------------- Always load fresh user ---------------- */
app.use(async (req, res, next) => {
  try {
    if (req.session.user?.id) {
      const freshUser = await prisma.user.findUnique({
        where: { id: req.session.user.id },
      });
      res.locals.user = freshUser || null;
    } else {
      res.locals.user = null;
    }
  } catch {
    res.locals.user = null;
  }

  res.locals.isAdmin = !!req.session.admin;
  next();
});

/* ---------------- Helpers (ORDER) ---------------- */
function makeOrderNo() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `NC-${y}${m}${day}-${rand}`;
}

/* ---------------- Helpers (RESET OTP) ---------------- */
function makeOtp6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

/* ---------------- RCON: give PlayerPoints ---------------- */
const RCON_HOST = process.env.RCON_HOST || "";
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD || "";
const PLAYERPOINTS_COMMAND =
  process.env.PLAYERPOINTS_COMMAND || "playerpoints give {player} {amount}";

function buildPlayerPointsCommand(player, amount) {
  const safePlayer = String(player || "").trim();
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  return PLAYERPOINTS_COMMAND.replace("{player}", safePlayer).replace(
    "{amount}",
    String(safeAmount)
  );
}

async function givePlayerPoints(player, amount) {
  // If env not set, skip silently
  if (!RCON_HOST || !RCON_PASSWORD) {
    console.warn("⚠️ RCON not configured (RCON_HOST/RCON_PASSWORD missing). Skipping PlayerPoints.");
    return { ok: false, reason: "RCON_NOT_CONFIGURED" };
  }

  const cmd = buildPlayerPointsCommand(player, amount);
  if (!player || !cmd) {
    console.warn("⚠️ Missing minecraftUsername, cannot give PlayerPoints.");
    return { ok: false, reason: "NO_PLAYER" };
  }

  let rcon;
  try {
    rcon = await Rcon.connect({
      host: RCON_HOST,
      port: RCON_PORT,
      password: RCON_PASSWORD,
      timeout: 8000,
    });

    const resp = await rcon.send(cmd);
    console.log("✅ RCON PlayerPoints sent:", cmd, "| resp:", resp);
    return { ok: true, resp };
  } catch (e) {
    console.error("❌ RCON givePlayerPoints failed:", e?.message || e);
    return { ok: false, reason: "RCON_ERROR", error: e?.message || String(e) };
  } finally {
    try {
      if (rcon) await rcon.end();
    } catch {}
  }
}

/* ---------------- Routes ---------------- */

// HOME
app.get("/", (req, res) => res.render("index"));

/* ---------- REGISTER ---------- */
app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/shop");
  return res.render("register", { error: null });
});

app.post("/register", async (req, res) => {
  try {
    const { email, name, minecraftUsername, phone, password, confirmPassword } =
      req.body;

    if (!email || !name || !minecraftUsername || !phone || !password || !confirmPassword) {
      return res.render("register", { error: "Please fill all fields." });
    }
    if (password !== confirmPassword) {
      return res.render("register", { error: "Passwords do not match." });
    }
    if (String(password).length < 6) {
      return res.render("register", { error: "Password must be at least 6 characters." });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.render("register", { error: "Email already registered." });

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        name,
        minecraftUsername,
        phone,
        passwordHash,
        coinBalance: 0,
      },
    });

    clearFails(req);

    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate error:", err);
        return res.redirect("/login");
      }
      req.session.user = { id: user.id, name: user.name, email: user.email };
      return res.redirect("/shop");
    });
  } catch (e) {
    console.error(e);
    return res.render("register", { error: "Registration failed. Try again." });
  }
});

/* ---------- LOGIN ---------- */
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/shop");

  if (isLocked(req)) {
    const msLeft = req.session.loginLockUntil - Date.now();
    const minLeft = Math.ceil(msLeft / 60000);
    return res.render("login", {
      error: `Too many wrong attempts. Please wait ${minLeft} minute(s) and try again.`,
    });
  }

  return res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.render("login", { error: "Enter name/email and password." });
    }

    if (isLocked(req)) {
      const msLeft = req.session.loginLockUntil - Date.now();
      const minLeft = Math.ceil(msLeft / 60000);
      return res.render("login", {
        error: `Too many wrong attempts. Please wait ${minLeft} minute(s) and try again.`,
      });
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { name: identifier }] },
    });

    if (!user) {
      recordFail(req);
      return res.render("login", { error: "User not found." });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      recordFail(req);
      return res.render("login", { error: "Wrong password." });
    }

    clearFails(req);

    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate error:", err);
        return res.render("login", { error: "Login error. Try again." });
      }
      req.session.user = { id: user.id, name: user.name, email: user.email };
      return res.redirect("/shop");
    });
  } catch (e) {
    console.error(e);
    return res.render("login", { error: "Login failed. Try again." });
  }
});

/* ---------- LOGOUT ---------- */
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    return res.redirect("/");
  });
});

/* ---------- FORGOT PASSWORD (OTP) ---------- */
app.get("/forgot-password", (req, res) => {
  if (req.session.user) return res.redirect("/shop");
  return res.render("forgot_password", { error: null, ok: null });
});

app.post("/forgot-password", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    if (!email) {
      return res.render("forgot_password", { error: "Enter your email.", ok: null });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Privacy: don’t reveal if email exists
    if (!user) {
      return res.render("forgot_password", {
        error: null,
        ok: "If this email is registered, we sent an OTP. Please check inbox/spam.",
      });
    }

    // Rate-limit: 1 OTP per 60 seconds
    if (user.resetOtpSentAt) {
      const diff = Date.now() - new Date(user.resetOtpSentAt).getTime();
      if (diff < 60 * 1000) {
        return res.render("forgot_password", {
          error: "Please wait 1 minute before requesting again.",
          ok: null,
        });
      }
    }

    const otp = makeOtp6();
    const expires = addMinutes(new Date(), 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetOtp: otp,
        resetOtpExpires: expires,
        resetOtpSentAt: new Date(),
      },
    });

    await sendMail({
      to: user.email,
      subject: "NamoVerse Coin Store Password Reset OTP",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6">
          <h2>NamoCoins Password Reset</h2>
          <p>Your OTP is:</p>
          <div style="font-size:28px;font-weight:800;letter-spacing:4px">${otp}</div>
          <p>This OTP will expire in <b>10 minutes</b>.</p>
          <p>If you didn't request this, ignore this email.</p>
        </div>
      `,
    });

    return res.render("forgot_password", {
      error: null,
      ok: "OTP sent! Check your email (also spam). Now go to Reset Password page.",
    });
  } catch (e) {
    console.error(e);
    return res.render("forgot_password", { error: "Failed to send OTP. Try again.", ok: null });
  }
});

app.get("/reset-password", (req, res) => {
  if (req.session.user) return res.redirect("/shop");
  return res.render("reset_password", { error: null, ok: null });
});

app.post("/reset-password", async (req, res) => {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const otp = (req.body.otp || "").trim();
    const password = req.body.password || "";
    const confirmPassword = req.body.confirmPassword || "";

    if (!email || !otp || !password || !confirmPassword) {
      return res.render("reset_password", { error: "Fill all fields.", ok: null });
    }
    if (password !== confirmPassword) {
      return res.render("reset_password", { error: "Passwords do not match.", ok: null });
    }
    if (password.length < 6) {
      return res.render("reset_password", { error: "Password must be at least 6 characters.", ok: null });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.resetOtp || !user.resetOtpExpires) {
      return res.render("reset_password", { error: "Invalid OTP or expired. Request a new OTP.", ok: null });
    }

    const expired = new Date(user.resetOtpExpires).getTime() < Date.now();
    if (expired) {
      return res.render("reset_password", { error: "OTP expired. Request a new OTP.", ok: null });
    }

    if (user.resetOtp !== otp) {
      return res.render("reset_password", { error: "Wrong OTP.", ok: null });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetOtp: null,
        resetOtpExpires: null,
        resetOtpSentAt: null,
      },
    });

    return res.render("reset_password", {
      error: null,
      ok: "Password changed successfully! Now login with your new password.",
    });
  } catch (e) {
    console.error(e);
    return res.render("reset_password", { error: "Reset failed. Try again.", ok: null });
  }
});

/* ---------- SHOP ---------- */
// ✅ IMPORTANT: pass coinRate so shop.ejs doesn't crash
app.get("/shop", requireAuth, async (req, res) => {
  const [products, coinRate] = await Promise.all([
    prisma.product.findMany({
      where: { active: true },
      orderBy: { priceINR: "asc" },
    }),
    getCoinRate(),
  ]);

  return res.render("shop", {
    products,
    coinRate,
    rate: coinRate, // for compatibility
  });
});

app.post("/buy/:productId", requireAuth, async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.productId },
  });
  if (!product) return res.redirect("/shop");

  const order = await prisma.order.create({
    data: {
      orderNo: makeOrderNo(),
      userId: req.session.user.id,
      productId: product.id,
      priceINR: product.priceINR,
      coins: product.coins,
      status: "PENDING_VERIFICATION",
      paymentMethod: "UPI_GPAY",
    },
  });

  return res.redirect(`/pay-upi/${order.id}`);
});

app.get("/pay-upi/:orderId", requireAuth, async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: { product: true },
  });

  if (!order || order.userId !== req.session.user.id) return res.redirect("/orders");

  const upiId = process.env.UPI_ID || "yourupiid@okaxis";
  const payeeName = process.env.UPI_PAYEE_NAME || "NamoCoins Store";
  const qrImagePath = "/qr/upi_qr.png";

  res.render("payupi", { order, upiId, payeeName, qrImagePath });
});

app.post("/pay-upi/:orderId/upload", requireAuth, upload.single("proof"), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
  });

  if (!order || order.userId !== req.session.user.id) return res.redirect("/orders");

  const upiTxnId = (req.body.upiTxnId || "").trim();

  await prisma.order.update({
    where: { id: order.id },
    data: {
      upiTxnId: upiTxnId || null,
      paymentProofUrl: req.file ? `/uploads/${req.file.filename}` : order.paymentProofUrl,
    },
  });

  return res.redirect("/orders");
});

app.get("/orders", requireAuth, async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.session.user.id },
    include: { product: true },
    orderBy: { createdAt: "desc" },
  });

  res.render("orders", { orders });
});

/* ---------------- ADMIN ---------------- */

app.get("/admin/login", (req, res) => res.render("admin_login", { error: null }));

app.post("/admin/login", (req, res) => {
  const { email, password } = req.body;

  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.redirect("/admin");
  }
  return res.render("admin_login", { error: "Wrong admin credentials." });
});

app.post("/admin/logout", (req, res) => {
  req.session.admin = false;
  return res.redirect("/admin/login");
});

// ✅ IMPORTANT: admin_dashboard needs orders + products + coinRate
app.get("/admin", requireAdmin, async (req, res) => {
  const [orders, products, coinRate] = await Promise.all([
    prisma.order.findMany({
      include: { user: true, product: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.product.findMany({ orderBy: { priceINR: "asc" } }),
    getCoinRate(),
  ]);

  return res.render("admin_dashboard", {
    orders,
    products,
    coinRate,
    rate: coinRate,
  });
});

// Admin: update conversion rate (+ optional recalc coins)
app.post("/admin/settings/rate", requireAdmin, async (req, res) => {
  // Your admin ejs uses name="coinRate"
  const rate = Number(req.body.coinRate);
  const recalc = req.body.recalc === "1" || req.body.recalc === "on";

  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return res.redirect("/admin");

  const newRate = Math.round(rate);

  await prisma.setting.upsert({
    where: { key: "conversionRate" },
    update: { intValue: newRate },
    create: { key: "conversionRate", intValue: newRate },
  });

  if (recalc) {
    const all = await prisma.product.findMany();
    await prisma.$transaction(
      all.map((p) =>
        prisma.product.update({
          where: { id: p.id },
          data: { coins: calcCoins(p.priceINR, newRate) },
        })
      )
    );
  }

  return res.redirect("/admin");
});

// Admin: edit product (matches your form action "/admin/product/:id/update")
app.post("/admin/product/:id/update", requireAdmin, async (req, res) => {
  const id = req.params.id;

  const name = String(req.body.name || "").trim();
  const priceINR = Number(req.body.priceINR);
  const coins = Number(req.body.coins);
  const active = req.body.active === "on";
  const bestSeller = req.body.bestSeller === "on";

  if (!name || !Number.isFinite(priceINR) || priceINR <= 0 || !Number.isFinite(coins) || coins < 0) {
    return res.redirect("/admin");
  }

  await prisma.product.update({
    where: { id },
    data: {
      name,
      priceINR: Math.round(priceINR),
      coins: Math.round(coins),
      active,
      bestSeller,
    },
  });

  return res.redirect("/admin");
});

// Admin: recalc product coins by rate (matches your "/admin/product/:id/recalc")
app.post("/admin/product/:id/recalc", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const coinRate = await getCoinRate();

  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return res.redirect("/admin");

  await prisma.product.update({
    where: { id },
    data: { coins: calcCoins(product.priceINR, coinRate) },
  });

  return res.redirect("/admin");
});

// Update order status (PAID adds coins + invoice + ✅ PlayerPoints)
app.post("/admin/order/:id/status", requireAdmin, async (req, res) => {
  const status = (req.body.status || "").trim();
  const allowed = new Set(["CREATED", "PENDING_VERIFICATION", "PAID", "REJECTED"]);
  if (!allowed.has(status)) return res.redirect("/admin");

  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { user: true, product: true },
  });
  if (!order) return res.redirect("/admin");

  const wasPaid = order.status === "PAID";

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status },
    include: { user: true, product: true },
  });

  if (!wasPaid && status === "PAID") {
    // 1) Website balance
    await prisma.user.update({
      where: { id: updated.user.id },
      data: { coinBalance: { increment: updated.coins } },
    });

    // 2) ✅ Minecraft PlayerPoints via RCON
    // Use minecraftUsername from DB
    const mc = updated.user.minecraftUsername;
    const rconRes = await givePlayerPoints(mc, updated.coins);
    if (!rconRes.ok) {
      console.warn("⚠️ PlayerPoints not added:", rconRes);
      // We do NOT fail the order; just log.
    }

    // 3) Invoice email
    try {
      const html = invoiceHtml({
        order: updated,
        user: updated.user,
        product: updated.product,
      });

      await sendMail({
        to: updated.user.email,
        subject: `Invoice - ${updated.orderNo} (NamoCoins Store)`,
        html,
      });
    } catch (e) {
      console.error("❌ Invoice email failed:", e.message);
    }
  }

  return res.redirect("/admin");
});

/* ---------------- Start Server ---------------- */
const port = Number(process.env.PORT || 3000);
app.listen(port, () =>
  console.log(`✅ NamoCoins Store running on ${port}`)
);
