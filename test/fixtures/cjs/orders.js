const Order = require("./Order");

exports.list = () => Order.find();
