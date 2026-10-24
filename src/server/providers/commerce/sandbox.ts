import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../errors";
import { zonedWallTimeToUtc } from "@/lib/time";
import type { CabOption, CabType, CommerceProvider, FoodQuote, Restaurant, TableSlot } from "./types";

// A fixed, fictional catalogue. Nothing here reaches a real restaurant, cab company or payment network.
const R = (r: Omit<Restaurant, "city">): Restaurant => ({ ...r, city: "Bengaluru" });
export const SANDBOX_RESTAURANTS: Restaurant[] = [
  R({ id: "r-spice-route", name: "Spice Route Kitchen", cuisine: ["North Indian", "Mughlai"], area: "Indiranagar", rating: 4.4, priceForTwoPaise: 90000, delivery: { feePaise: 4000, etaMinutes: 35 }, dineIn: { tables: true, capacityPerSlot: 4 },
    menu: [
      { id: "m-paneer-tikka", name: "Paneer Tikka", pricePaise: 28000, veg: true },
      { id: "m-butter-chicken", name: "Butter Chicken", pricePaise: 34000, veg: false },
      { id: "m-dal-makhani", name: "Dal Makhani", pricePaise: 24000, veg: true },
      { id: "m-garlic-naan", name: "Garlic Naan", pricePaise: 6000, veg: true },
      { id: "m-jeera-rice", name: "Jeera Rice", pricePaise: 16000, veg: true },
    ] }),
  R({ id: "r-dosa-corner", name: "Dosa Corner", cuisine: ["South Indian"], area: "Koramangala", rating: 4.6, priceForTwoPaise: 40000, delivery: { feePaise: 2500, etaMinutes: 25 }, dineIn: { tables: true, capacityPerSlot: 6 },
    menu: [
      { id: "m-masala-dosa", name: "Masala Dosa", pricePaise: 12000, veg: true },
      { id: "m-idli-vada", name: "Idli Vada", pricePaise: 9000, veg: true },
      { id: "m-filter-coffee", name: "Filter Coffee", pricePaise: 4000, veg: true },
      { id: "m-pongal", name: "Ven Pongal", pricePaise: 11000, veg: true },
    ] }),
  R({ id: "r-biryani-house", name: "Hyderabad Biryani House", cuisine: ["Biryani", "Hyderabadi"], area: "HSR Layout", rating: 4.3, priceForTwoPaise: 70000, delivery: { feePaise: 3500, etaMinutes: 40 }, dineIn: null,
    menu: [
      { id: "m-chicken-biryani", name: "Chicken Dum Biryani", pricePaise: 32000, veg: false },
      { id: "m-veg-biryani", name: "Veg Biryani", pricePaise: 26000, veg: true },
      { id: "m-mirchi-salan", name: "Mirchi Ka Salan", pricePaise: 12000, veg: true },
      { id: "m-double-ka-meetha", name: "Double Ka Meetha", pricePaise: 11000, veg: true },
    ] }),
  R({ id: "r-green-bowl", name: "The Green Bowl", cuisine: ["Healthy", "Salads"], area: "Whitefield", rating: 4.2, priceForTwoPaise: 60000, delivery: { feePaise: 3000, etaMinutes: 30 }, dineIn: { tables: true, capacityPerSlot: 3 },
    menu: [
      { id: "m-quinoa-bowl", name: "Quinoa Power Bowl", pricePaise: 29000, veg: true },
      { id: "m-chicken-salad", name: "Grilled Chicken Salad", pricePaise: 31000, veg: false },
      { id: "m-cold-pressed", name: "Cold-pressed Juice", pricePaise: 14000, veg: true },
    ] }),
  R({ id: "r-pasta-street", name: "Pasta Street", cuisine: ["Italian", "Pizza"], area: "MG Road", rating: 4.5, priceForTwoPaise: 120000, delivery: { feePaise: 5000, etaMinutes: 45 }, dineIn: { tables: true, capacityPerSlot: 5 },
    menu: [
      { id: "m-margherita", name: "Margherita Pizza", pricePaise: 38000, veg: true },
      { id: "m-arrabbiata", name: "Penne Arrabbiata", pricePaise: 36000, veg: true },
      { id: "m-tiramisu", name: "Tiramisu", pricePaise: 25000, veg: true },
    ] }),
  R({ id: "r-slice-republic", name: "Slice Republic", cuisine: ["Pizza", "Italian", "Fast food"], area: "Koramangala", rating: 4.3, priceForTwoPaise: 70000, delivery: { feePaise: 3000, etaMinutes: 30 }, dineIn: null,
    menu: [
      { id: "m-margherita-m", name: "Margherita pizza (medium)", pricePaise: 29900, veg: true },
      { id: "m-margherita-l", name: "Margherita pizza (large)", pricePaise: 44900, veg: true },
      { id: "m-farmhouse-m", name: "Farmhouse pizza (medium)", pricePaise: 39900, veg: true },
      { id: "m-farmhouse-l", name: "Farmhouse pizza (large)", pricePaise: 57900, veg: true },
      { id: "m-peppy-paneer-m", name: "Peppy Paneer pizza (medium)", pricePaise: 42900, veg: true },
      { id: "m-chicken-tikka-m", name: "Chicken Tikka pizza (medium)", pricePaise: 46900, veg: false },
      { id: "m-chicken-tikka-l", name: "Chicken Tikka pizza (large)", pricePaise: 64900, veg: false },
      { id: "m-garlic-bread", name: "Garlic breadsticks", pricePaise: 14900, veg: true },
      { id: "m-choco-lava", name: "Choco lava cake", pricePaise: 10900, veg: true },
      { id: "m-cola", name: "Cola (500 ml)", pricePaise: 6000, veg: true },
    ] }),
  R({ id: "r-coastal-curry", name: "Coastal Curry Co.", cuisine: ["Seafood", "Mangalorean"], area: "Jayanagar", rating: 4.4, priceForTwoPaise: 100000, delivery: null, dineIn: { tables: true, capacityPerSlot: 4 },
    menu: [
      { id: "m-fish-curry", name: "Mangalorean Fish Curry", pricePaise: 42000, veg: false },
      { id: "m-neer-dosa", name: "Neer Dosa (3)", pricePaise: 9000, veg: true },
      { id: "m-prawn-ghee-roast", name: "Prawn Ghee Roast", pricePaise: 52000, veg: false },
    ] }),
];

const h = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0);
const ref = (prefix: string) => `${prefix}-${randomBytes(3).toString("hex").toUpperCase()}`;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const TZ = "Asia/Kolkata";

const CABS: { type: CabType; label: string; seats: number; basePaise: number; perKmPaise: number }[] = [
  { type: "AUTO", label: "Auto rickshaw", seats: 3, basePaise: 3000, perKmPaise: 1500 },
  { type: "MINI", label: "Mini (hatchback)", seats: 4, basePaise: 5000, perKmPaise: 1400 },
  { type: "SEDAN", label: "Sedan", seats: 4, basePaise: 7000, perKmPaise: 1800 },
  { type: "SUV", label: "SUV", seats: 6, basePaise: 10000, perKmPaise: 2400 },
];
// Dinner and lunch seatings, 30-minute slots (restaurant local time).
const SLOT_TIMES = ["12:00", "12:30", "13:00", "13:30", "14:00", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00"];

export const sandboxCommerce: CommerceProvider = {
  name: "sandbox",
  sandbox: true,
  timezone: TZ,
  async searchRestaurants({ query, cuisine, mode }) {
    const q = query ? norm(query) : "";
    const c = cuisine ? norm(cuisine) : "";
    return SANDBOX_RESTAURANTS.filter((r) => {
      if (mode === "delivery" && !r.delivery) return false;
      if (mode === "dine_in" && !r.dineIn?.tables) return false;
      const hay = norm([r.name, r.area, ...r.cuisine, ...r.menu.map((m) => m.name)].join(" "));
      if (c && !r.cuisine.some((x) => norm(x).includes(c))) return false;
      return !q || q.split(" ").every((w) => hay.includes(w));
    });
  },
  async getRestaurant(id) {
    return SANDBOX_RESTAURANTS.find((r) => r.id === id) ?? null;
  },
  async quoteFood(restaurantId, items): Promise<FoodQuote> {
    const r = SANDBOX_RESTAURANTS.find((x) => x.id === restaurantId);
    if (!r) throw new AppError("NOT_FOUND", "Unknown restaurant. Use search_restaurants to find one.");
    if (!r.delivery) throw new AppError("VALIDATION", `${r.name} doesn't deliver; it only takes table reservations.`);
    const merged = new Map<string, number>();
    for (const i of items) merged.set(i.itemId, (merged.get(i.itemId) ?? 0) + i.quantity);
    const lines = [...merged].map(([itemId, quantity]) => {
      const m = r.menu.find((x) => x.id === itemId);
      if (!m) throw new AppError("VALIDATION", `“${itemId}” isn't on ${r.name}'s menu. Use get_menu for item ids.`);
      return { itemId, name: m.name, quantity, unitPaise: m.pricePaise, totalPaise: m.pricePaise * quantity };
    });
    const subtotalPaise = lines.reduce((a, l) => a + l.totalPaise, 0);
    const taxesPaise = Math.round(subtotalPaise * 0.05);
    return { restaurant: { id: r.id, name: r.name }, lines, subtotalPaise, deliveryFeePaise: r.delivery.feePaise, taxesPaise, totalPaise: subtotalPaise + taxesPaise + r.delivery.feePaise, etaMinutes: r.delivery.etaMinutes };
  },
  async placeFoodOrder(quote) {
    return { reference: ref("FD"), etaMinutes: quote.etaMinutes };
  },
  async quoteCab(pickup, drop): Promise<CabOption[]> {
    const [a, b] = [norm(pickup), norm(drop)].sort();
    if (a === b) throw new AppError("VALIDATION", "Pickup and drop-off are the same place.");
    const distanceKm = 3 + (h(`${a}|${b}`) % 220) / 10; // 3–25 km, the same both ways
    return CABS.map((c, i) => ({
      type: c.type,
      label: c.label,
      seats: c.seats,
      distanceKm: Math.round(distanceKm * 10) / 10,
      farePaise: Math.round((c.basePaise + c.perKmPaise * distanceKm) / 100) * 100,
      pickupEtaMinutes: 3 + ((h(a) + i) % 8),
      tripMinutes: Math.round(distanceKm * 3.2),
    }));
  },
  async bookCab(option) {
    const drivers = ["Manjunath", "Suresh", "Imran", "Lakshmi", "Ravi", "Anitha"];
    const n = h(option.type + Date.now()) % drivers.length;
    return { reference: ref("CB"), driver: `${drivers[n]} (sandbox driver)`, vehicle: `${option.label} · KA 0${1 + (n % 9)} SB ${1000 + (h(String(n)) % 9000)}` };
  },
  async tableSlots(restaurantId, date, partySize, taken): Promise<TableSlot[]> {
    const r = SANDBOX_RESTAURANTS.find((x) => x.id === restaurantId);
    if (!r) throw new AppError("NOT_FOUND", "Unknown restaurant. Use search_restaurants to find one.");
    if (!r.dineIn?.tables) throw new AppError("VALIDATION", `${r.name} is delivery-only; it doesn't take table reservations.`);
    if (partySize > 12) throw new AppError("VALIDATION", "For more than 12 people, please call the restaurant.");
    return SLOT_TIMES.map((t) => {
      const start = zonedWallTimeToUtc(date, t, TZ);
      const busy = h(`${r.id}|${date}|${t}`) % 5 === 0; // some slots are already full
      return { start, available: !busy && taken(start) < r.dineIn!.capacityPerSlot };
    });
  },
  async reserveTable() {
    return { reference: ref("TB") };
  },
};
