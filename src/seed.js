 const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const packs = [
    { sku: "NAMO-45", name: "NamoCoins Pack 45", priceINR: 45, coins: 79 },
    { sku: "NAMO-99", name: "NamoCoins Pack 99", priceINR: 99, coins: 174 },
    { sku: "NAMO-149", name: "NamoCoins Pack 149", priceINR: 149, coins: 261 },
    { sku: "NAMO-249", name: "NamoCoins Pack 249", priceINR: 249, coins: 436 },
    { sku: "NAMO-399", name: "NamoCoins Pack 399", priceINR: 399, coins: 699 },
    { sku: "NAMO-599", name: "NamoCoins Pack 599", priceINR: 599, coins: 1049 },
    { sku: "NAMO-999", name: "NamoCoins Pack 999", priceINR: 999, coins: 1749 },
    { sku: "NAMO-1499", name: "NamoCoins Pack 1499", priceINR: 1499, coins: 2624 }
  ];

  for (const p of packs) {
    await prisma.product.upsert({
      where: { sku: p.sku },
      update: p,
      create: p
    });
  }

  console.log("✅ Seed done: products created/updated.");
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
