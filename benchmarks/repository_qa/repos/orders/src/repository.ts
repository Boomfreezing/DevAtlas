export function insertOrder(db, total) {
  return db.query("INSERT INTO orders(total_cents) VALUES (?) RETURNING id", [total]);
}
