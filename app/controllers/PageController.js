const path = require('path');

class PageController {
  static getAdmin(req, res) {
    res.sendFile(path.resolve(__dirname, '..', 'views', 'public', 'admin.html'));
  }

  static getMobile(req, res) {
    res.sendFile(path.resolve(__dirname, '..', 'views', 'public', 'mobile.html'));
  }

  static getHome(req, res) {
    res.sendFile(path.resolve(__dirname, '..', 'views', 'public', 'mobile.html'));
  }
}

module.exports = PageController;
