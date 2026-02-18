function invoiceHtml({ order, user, product }) {
  const date = new Date(order.createdAt).toLocaleString("en-IN");
  const status = order.status;

  return `
  <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:18px;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <h2 style="margin:0;">NamoCoins Store</h2>
        <div style="color:#555;">Minecraft Coin Shop</div>
      </div>
      <div style="text-align:right;">
        <div style="font-weight:bold;">INVOICE</div>
        <div style="color:#555;">${date}</div>
      </div>
    </div>

    <hr style="margin:16px 0;border:none;border-top:1px solid #eee;" />

    <div style="display:flex;gap:20px;flex-wrap:wrap;">
      <div style="flex:1;min-width:260px;">
        <h3 style="margin:0 0 8px;">Billed To</h3>
        <div><b>${user.name}</b></div>
        <div>${user.email}</div>
        <div>MC: ${user.minecraftUsername}</div>
        <div>Phone: ${user.phone}</div>
      </div>

      <div style="flex:1;min-width:260px;">
        <h3 style="margin:0 0 8px;">Order Details</h3>
        <div><b>Order No:</b> ${order.orderNo}</div>
        <div><b>Status:</b> ${status}</div>
        <div><b>Payment:</b> ${order.paymentMethod || "UPI"}</div>
        <div><b>UPI Txn:</b> ${order.upiTxnId || "-"}</div>
      </div>
    </div>

    <div style="margin-top:16px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;border-bottom:1px solid #eee;padding:10px;">Item</th>
            <th style="text-align:right;border-bottom:1px solid #eee;padding:10px;">Coins</th>
            <th style="text-align:right;border-bottom:1px solid #eee;padding:10px;">Price</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:10px;border-bottom:1px solid #f3f3f3;">${product.name}</td>
            <td style="padding:10px;text-align:right;border-bottom:1px solid #f3f3f3;">${order.coins}</td>
            <td style="padding:10px;text-align:right;border-bottom:1px solid #f3f3f3;">₹${order.priceINR}</td>
          </tr>
        </tbody>
      </table>

      <div style="text-align:right;margin-top:10px;font-size:18px;">
        <b>Total: ₹${order.priceINR}</b>
      </div>
    </div>

    <div style="margin-top:18px;color:#666;font-size:12px;">
      This is a digital invoice. If you have any issues, reply to this email.<br/>
      Not affiliated with Mojang/Microsoft.
    </div>
  </div>
  `;
}

module.exports = { invoiceHtml };
