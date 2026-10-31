use super::models::Order;
use crate::models::Status;

pub fn describe(o: &Order, s: Status) -> String {
    format!("{} {:?}", o.total(), s)
}
