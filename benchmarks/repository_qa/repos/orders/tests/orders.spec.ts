import { createOrder } from "../src/orders";

export function checkEmptyOrder(db) {
  try {
    createOrder(db, []);
  } catch (error) {
    return error.message === "empty order";
  }
  throw new Error("expected failure");
}
