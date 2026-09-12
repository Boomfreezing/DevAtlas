import { insertOrder } from "./repository";

export function createOrder(db, items) {
  if (items.length === 0) throw new Error("empty order");
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return insertOrder(db, total);
}
