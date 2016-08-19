'use strict';

var crossref   = require('crossref');
var cache      = ezpaarse.lib('cache')('crossref');
var doiPattern = /^10\.[0-9]{4,}\/[a-z0-9\-\._:;\(\)\/]+$/i;

/**
 * Enrich ECs with crossref data
 */
module.exports = function () {
  var self     = this;
  var req      = this.request;
  var report   = this.report;

  var noCrossref = (req.header('crossref-enrich') || '').toLowerCase() == 'false';

  var ttl = parseInt(req.header('crossref-ttl')) || 3600 * 24 * 7;

  if (noCrossref) {
    self.logger.verbose('Crossref enrichment not activated');
    return function (ec, next) { next(); };
  }

  this.job.outputFields.added.push('type');
  this.job.outputFields.added.push('subject');

  var buffer        = [];
  var throttle      = parseInt(req.header('crossref-throttle')) || 200;
  // Maximum number of DOIs to query in a single request
  var paquetSize    = parseInt(req.header('crossref-paquet-size')) || 50;
  // Minimum number of ECs to keep before resolving them
  var bufferSize    = 0;
  if (req.header('crossref-buffer-size') != '0') {
    bufferSize = parseInt(req.header('crossref-buffer-size')) || 1000;
  }
  var busy          = false;
  var finalCallback = null;

  self.logger.verbose('Crossref enrichment activated');
  self.logger.verbose('Crossref throttle: %dms', throttle);
  self.logger.verbose('Crossref paquet size: %d', paquetSize);
  self.logger.verbose('Crossref buffer size: %d', bufferSize);

  report.set('general', 'crossref-queries', 0);
  report.set('general', 'crossref-fails', 0);
  report.set('general', 'crossref-invalid-dois', 0);

  /**
   * Iterate over the buffer, remove ECs with no DOI or cached DOI
   * return a packet of ecs with an uncached DOI
   */
  function getPacket(callback) {
    var packet = [];

    (function checkNextEC() {

      if (packet.length >= paquetSize) { return callback(null, packet); }

      var ec = buffer.shift();
      if (!ec) { return callback(null, packet); }

      if (!ec[0].doi && !ec[0].pii) {
        ec[1]();
        return checkNextEC();
      }

      if (!doiPattern.test(ec[0].doi) && !ec[0].pii) {
        report.inc('general', 'crossref-invalid-dois');
        ec[1]();
        return checkNextEC();
      }

      cache.get(ec[0].doi, function (err, cachedDoc) {
        if (cachedDoc) {
          aggregate(cachedDoc, '', ec);
          ec[1]();
        } else {
          packet.push(ec);
        }
        checkNextEC();
      });
    })();
  }

  function drainBuffer(callback) {
    if (buffer.length === 0) { return (finalCallback || callback)(); }
    if (buffer.length < bufferSize && !finalCallback) { return callback(); }

    getPacket(function (err, packet) {

      if (packet.length === 0) {

        self.logger.silly('Crossref: no doi or pii in the paquet');
        return setImmediate(function () { drainBuffer(callback); });
      }

      var dois = [];
      var piis = [];
      packet.forEach(function (ec) {
        if (ec[0].doi) {
          dois.push(ec[0].doi);
        } else if (ec[0].pii) {
          piis.push(ec[0].pii);
        }
      });

   // implement function works filter by doi
      if (dois.length > 0) {
        crossref.works({filter :  {'doi': dois} }, function(err, list) {

          if (err || !Array.isArray(list)) {

            if (err) { self.logger.error('Crossref: the query failed', err); }
            else     { self.logger.error('Crossref: got an invalid response'); }

            report.inc('general', 'crossref-fails');

            packet.forEach(function (ec) { ec[1](); });

            return setTimeout(function() { drainBuffer(callback); }, throttle);
          }
          var notFound = [];

          packet.forEach(function (ec) {

            var item;
            if (ec[0].doi) {

              for (let i = list.length - 1; i >= 0; i--) {
                if (ec[0].doi.toLowerCase() == list[i]['DOI'].toLowerCase()) {
                  item = list[i];
                  break;
                }
              }

              if (item) {
                item = aggregate(item, '', ec);
              } else {
                notFound.push(ec[0].doi);
              }
              cacheResults(item);
              ec[1]();
            }
          });
          function cacheNotFound() {
            var doi = notFound.pop();
            if (!doi) { return setTimeout(function() { drainBuffer(callback); }, throttle); }
            cacheNotFound();
          }

          function cacheResults(item) {

            if (!item) { return cacheNotFound(); }

            cache.set(item['DOI'].toLowerCase(), item, function (err, result) {
              if (err) { report.inc('general', 'crossref-cache-fail'); }
              cacheResults();
            });
          }
        });
      }
    // implement function works filter by pii
      if (piis.length > 0) {
        crossref.works({filter :  {'alternative-id': piis} }, function(err, list) {

          if (err || !Array.isArray(list)) {

            if (err) { self.logger.error('Crossref: the query failed', err); }
            else     { self.logger.error('Crossref: got an invalid response'); }

            report.inc('general', 'crossref-fails');

            packet.forEach(function (ec) { ec[1](); });
            return setTimeout(function() { drainBuffer(callback); }, throttle);
          }
          var notFound = [];

          packet.forEach(function (ec) {

            var item;
            if (ec[0].pii) {

              for (let i = list.length - 1; i >= 0; i--) {
                if (ec[0].pii == list[i]['alternative-id'][0]) {

                  item = list[i];
                  break;
                }
              }

              if (item) {
                item = aggregate(item, '', ec);
              } else {
                notFound.push(ec[0].pii);
              }
              cacheResults(item);
              ec[1]();
            }
          });
          function cacheNotFound() {
            var pii = notFound.pop();
            if (!pii) { return setTimeout(function() { drainBuffer(callback); }, throttle); }
            cacheNotFound();
          }

          function cacheResults(item) {
            if (!item) { return cacheNotFound(); }
            cache.set(item['DOI'], item, function (err, result) {
              if (err) { report.inc('general', 'crossref-cache-fail'); }
              cacheResults();
            });
          }
        });
      }
    });
  }

  function aggregate(item, fieldsAggregate, ec) {
    if (item['type'] && /([a-z]+)\-([a-z]+)/.test(item['type'])) {
      ec[0]['publication_title'] = ec[0]['publication_title'] || item['container-title'];
    } else {
      ec[0]['publication_title'] = ec[0]['publication_title'] || item['title'];
    }
    if (item['issued'] && item['issued']['date-parts'] && item['issued']['date-parts'][0]) {
      ec[0]['publication_date'] = ec[0]['publication_date'] || item['issued']['date-parts'][0][0];
    }
    if (item['subject'] && Array.isArray(item['subject'])) {
      ec[0]['subject'] = item['subject'].join(', ');
    }

    ec[0]['publisher_name'] = ec[0]['publisher_name'] || item['publisher'];
    ec[0]['type'] = item['type'];

    if (item['ISSN']) {
      var identifier = /([0-9A-Z\-]*)\,([0-9\-]+)/.exec(item['ISSN']);
      if (identifier && identifier[1]) {
        ec[0]['print_identifier'] = ec[0]['print_identifier'] || identifier[1];
        if (identifier[2]) {
          ec[0]['online_identifier'] = ec[0]['online_identifier'] || identifier[2]  ;
        }
      } else {
          ec[0]['print_identifier'] = ec[0]['print_identifier'] || item['ISSN'];
      }
    }
    return item;
  }

  function process(ec, next) {
    if (!ec) {

      finalCallback = next;
      if (!busy) { drainBuffer(function () { next(); }); }
      return;
    }

    buffer.push([ec, next]);
    if (buffer.length > bufferSize && !busy) {

      busy = true;
      self.saturate();
      drainBuffer(function () {

        busy = false;
        self.drain();
      });
    }
  }

  return new Promise(function (resolve, reject) {
    cache.checkIndexes(ttl, function (err) {
      if (err) {
        self.logger.error('Crossref: failed to ensure indexes');
        return reject(new Error('failed to ensure indexes for the cache of Crossref'));
      }

      resolve(process);
    });
  });
};