export type MenuItem = { id: string; name: string; pricePaise: number; veg: boolean; description?: string };
export type Restaurant = {
  id: string;
  name: string;
  cuisine: string[];
  area: string;
  city: string;
  rating: number;
  priceForTwoPaise: number;
  delivery: { feePaise: number; etaMinutes: number } | null;
  dineIn: { tables: boolean; capacityPerSlot: number } | null;
  menu: MenuItem[];
};
export type FoodQuote = {
  restaurant: { id: string; name: string };
  lines: { itemId: string; name: string; quantity: number; unitPaise: number; totalPaise: number }[];
  subtotalPaise: number;
  deliveryFeePaise: number;
  taxesPaise: number;
  totalPaise: number;
  etaMinutes: number;
};
export type CabType = "AUTO" | "MINI" | "SEDAN" | "SUV";
export type CabOption = { type: CabType; label: string; seats: number; farePaise: number; pickupEtaMinutes: number; tripMinutes: number; distanceKm: number };
export type TableSlot = { start: Date; available: boolean };

export interface CommerceProvider {
  readonly name: string;
  /** Sandbox providers never place real orders or take payment. */
  readonly sandbox: boolean;
  readonly timezone: string;
  searchRestaurants(q: { query?: string; cuisine?: string; mode?: "delivery" | "dine_in" }): Promise<Restaurant[]>;
  getRestaurant(id: string): Promise<Restaurant | null>;
  quoteFood(restaurantId: string, items: { itemId: string; quantity: number }[]): Promise<FoodQuote>;
  placeFoodOrder(quote: FoodQuote, address: string): Promise<{ reference: string; etaMinutes: number }>;
  quoteCab(pickup: string, drop: string): Promise<CabOption[]>;
  bookCab(option: CabOption, pickup: string, drop: string, pickupAt: Date): Promise<{ reference: string; driver: string; vehicle: string }>;
  tableSlots(restaurantId: string, date: string, partySize: number, taken: (start: Date) => number): Promise<TableSlot[]>;
  reserveTable(restaurantId: string, start: Date, partySize: number): Promise<{ reference: string }>;
}
