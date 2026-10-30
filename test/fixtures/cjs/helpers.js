const jwt = require("jsonwebtoken");
const User = require("./User");

const getToken = (req) => req.headers.authorization;

function verify(req) {
  return jwt.verify(getToken(req)) && User.findById(1);
}

module.exports = { getToken, verify };
