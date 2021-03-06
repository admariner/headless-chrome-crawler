const reduce = require('lodash/reduce');
const pick = require('lodash/pick');
const isEmpty = require('lodash/isEmpty');
const uniq = require('lodash/uniq');
const noop = require('lodash/noop');
const devices = require('puppeteer/DeviceDescriptors');
const {
  resolveUrl,
  debugConsole,
  debugDialog,
  tracePublicAPI,
} = require('./helper');

const GOTO_OPTIONS = [
  'timeout',
  'waitUntil',
];
const RESPONSE_FIELDS = [
  'ok',
  'url',
  'status',
  'headers',
];

const REQUEST_FIELDS = [
  'headers',
];

const jQueryPath = require.resolve('jquery');

class Crawler {
  /**
   * @param {!Puppeteer.Page} page
   * @param {!Object} options
   */
  constructor(page, options) {
    this._page = page;
    this._page.on('request', request => void this._handlePageRequest(options, request));
    this._page.on('pageerror', text => void debugConsole(text));
    this._page.on('console', msg => void debugConsole(`${msg.type()} ${msg.text()} at ${options.url}`));
    this._page.on('dialog', dialog => this._handleDialog(dialog));
    this._options = options;
    this._preBrowserRequest = options.preBrowserRequest || ((_, request) => request.continue());
  }

  /**
   * @return {!Promise}
   */
  crawl() {
    const crawlStart = +new Date();
    return this._prepare()
      .then(() => this._request())
      .then(response => (
        response.status() >= 300 && response.status() <= 399
          ? ({
            response: this._reduceResponse(response),
            request: this._reduceRequest(response.request()),
            timing: {
              start: crawlStart,
              end: +new Date(),
            },
          })
          : this._waitFor()
            .then(() => (
              Promise.all([
                this._scrape(),
                this._screenshot(),
                this._collectLinks(response.url),
                response.text(),
              ])
            ))
            .then(([result, screenshot, links, text]) => ({
              timing: {
                start: crawlStart,
                end: +new Date(),
              },
              response: this._reduceResponse(response),
              request: this._reduceRequest(response.request()),
              redirectChain: this._reduceRedirectChain(response.request()),
              result,
              screenshot,
              links,
              text,
            }))
      ));
  }

  /**
   * @return {!Promise}
   */
  close() {
    return this._page.close();
  }

  /**
   * @return {!Puppeteer.Page}
   */
  page() {
    return this._page;
  }

  /**
   * @return {!Promise}
   * @private
   */
  _prepare() {
    return Promise.all([
      this._preventNewTabs(),
      this._authenticate(),
      this._emulate(),
      this._setFollowRedirects(),
      this._setCacheEnabled(),
      this._setUserAgent(),
      this._setExtraHeaders(),
      this._setJavaScriptEnabled(),
    ]);
  }

  /**
   * @return {!Promise}
   * @private
   */
  _preventNewTabs() {
    return this._page.evaluateOnNewDocument(() => {
      window.open = (url => {
        window.location.href = url;
        return window;
      });
    });
  }

  /**
   * @return {!Promise}
   * @private
   */
  _authenticate() {
    const credentials = pick(this._options, ['username', 'password']);
    if (!credentials.username && !credentials.password) return Promise.resolve();
    return this._page.authenticate(credentials);
  }

  /**
   * @return {!Promise}
   * @private
   */
  _emulate() {
    if (!this._options.device) return Promise.resolve();
    return this._page.emulate(devices[this._options.device]);
  }

  /**
   * @return {!Promise}
   * @private
   */
  _setCacheEnabled() {
    if (this._options.browserCache) return Promise.resolve();
    // @ts-ignore
    return this._page.setCacheEnabled(false);
  }

  /**
   * @return {!Promise}
   * @private
   */
  _setJavaScriptEnabled() {
    if (this._options.javaScriptEnabled) return Promise.resolve();
    return this._page.setJavaScriptEnabled(false);
  }

  /**
   * @return {!Promise}
   * @private
   */
  _setUserAgent() {
    if (!this._options.userAgent) return Promise.resolve();
    return this._page.setUserAgent(this._options.userAgent);
  }

  /**
   * @return {!Promise}
   * @private
   */
  _setExtraHeaders() {
    if (!this._options.extraHeaders || isEmpty(this._options.extraHeaders)) {
      return Promise.resolve();
    }
    return this._page.setExtraHTTPHeaders(this._options.extraHeaders);
  }

  _setFollowRedirects() {
    // FIXME should be mutualised with other potential features (ex: skip images, etc.)
    return this._page.setRequestInterception(!this._options.followRedirects);
  }

  _handlePageRequest(options, request) {
    if (request.resourceType() === 'document' && request.url() !== options.url) {
      return request.respond({
        body: '',
      });
    }
    return this._preBrowserRequest(options, request);
  }

  /**
   * @param {!Puppeteer.Dialog} dialog
   * @return {!Promise}
   * @private
   */
  _handleDialog(dialog) {
    debugDialog(`${dialog.type()} ${dialog.message()} at ${this._options.url}`);
    return dialog.dismiss();
  }

  /**
   * @return {!Promise}
   * @private
   */
  _request() {
    /*
    return new Promise((resolve) => {
      let returnValue = null;

      this._page.on('response', (response) => {
        if (returnValue === null) {
          returnValue = response;
        }
      });

      this._page.on('domcontentloaded', () => {
        resolve(returnValue);
      });

      return this._page.evaluate((url) => window.location = url, this._options.url);
    });
*/
    const gotoOptions = pick(this._options, GOTO_OPTIONS);
    return this._page.goto(this._options.url, gotoOptions);
  }

  /**
   * @return {!Promise}
   * @private
   */
  _waitFor() {
    if (!this._options.waitFor) return Promise.resolve();
    return this._page.waitFor(
      this._options.waitFor.selectorOrFunctionOrTimeout,
      this._options.waitFor.options,
      ...(this._options.waitFor.args || []) // eslint-disable-line comma-dangle
    );
  }

  /**
   * @return {!Promise}
   * @private
   */
  _scrape() {
    const evaluatePage = this._options.evaluatePage || noop;
    return this._addJQuery()
      .then(() => this._page.evaluate(evaluatePage));
  }

  /**
   * @return {!Promise}
   * @private
   */
  _addJQuery() {
    if (!this._options.jQuery) return Promise.resolve();
    return this._page.addScriptTag({ path: jQueryPath });
  }

  /**
   * @return {!Promise}
   * @private
   */
  _screenshot() {
    if (!this._options.screenshot) return Promise.resolve(null);
    return this._page.screenshot(this._options.screenshot);
  }

  /**
   * @param {!string} baseUrl
   * @return {!Promise}
   * @private
   */
  _collectLinks(baseUrl) {
    const links = [];
    return this._page.exposeFunction('pushToLinks', link => {
      const _link = resolveUrl(link, baseUrl);
      if (_link) links.push(_link);
    })
      .then(() => (
        this._page.evaluate(() => {
          function findLinks(document) {
            document.querySelectorAll('a[href]')
              .forEach(link => {
                // @ts-ignore
                window.pushToLinks(link.href);
              });
            document.querySelectorAll('iframe,frame')
              .forEach(frame => {
                try {
                  findLinks(frame.contentDocument);
                } catch (e) {
                  console.warn(e.message);
                  // @ts-ignore
                  if (frame.src) window.pushToLinks(frame.src);
                }
              });
          }
          findLinks(window.document);
        })
      ))
      .then(() => uniq(links));
  }

  /**
   * @param {!Response} response
   * @return {!Object}
   * @private
   */
  _reduceResponse(response) {
    // FIXME: should resolveUrl the location header.
    return this._reduceByKeys(RESPONSE_FIELDS, response);
  }

  /**
   * @param {!Request} request
   * @returns {!Object}
   * @private
   */
  _reduceRequest(request) {
    return this._reduceByKeys(REQUEST_FIELDS, request);
  }

  /**
   * @param {!Request} request
   * @return {!Array}
   * @private
   */
  _reduceRedirectChain(request) {
    return request
      .redirectChain()
      .map(redirectRequest => ({
        url: redirectRequest.url(),
        request: this._reduceRequest(redirectRequest),
        // FIXME: .response() may return NULL
        response: this._reduceResponse(redirectRequest.response()),
      }));
  }

  /**
   * @param {!Array) keys
   * @param object
   * @returns {!Object}
   * @private
   */
  _reduceByKeys(keys, object) {
    return reduce(keys, (memo, field) => {
      memo[field] = object[field]();
      return memo;
    }, {});
  }
}

tracePublicAPI(Crawler);

module.exports = Crawler;
