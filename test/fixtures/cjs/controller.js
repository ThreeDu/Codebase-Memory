const { verify, getToken: token } = require("./helpers");

exports.login = (req) => verify(req) && token(req);
