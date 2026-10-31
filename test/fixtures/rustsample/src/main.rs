mod models;
mod util;

use crate::models::{Order, Status as OrderStatus};
use serde::Serialize;

fn main() {
    let o = Order::new(3);
    println!("{}", util::describe(&o, OrderStatus::Open));
}
