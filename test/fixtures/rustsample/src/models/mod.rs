pub mod status;

pub use status::Status;

pub struct Order {
    pub qty: u32,
}

impl Order {
    pub fn new(qty: u32) -> Self {
        Order { qty }
    }

    pub fn total(&self) -> u32 {
        self.qty * 10
    }
}
