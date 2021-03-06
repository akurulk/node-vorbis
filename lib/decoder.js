
/**
 * Module dependencies.
 */

var debug = require('debug')('vorbis:decoder');
var binding = require('./binding');
var inherits = require('util').inherits;
var Readable = require('stream').Readable;

// node v0.8.x compat
if (!Readable) Readable = require('readable-stream');

/**
 * Module exports.
 */

module.exports = Decoder;

/**
 * The `Decoder` class.
 * Accepts "ogg_page" Buffer instances and outputs raw PCM data.
 *
 * @param {Object} opts
 * @api public
 */

function Decoder (stream, opts) {
  if (!(this instanceof Decoder)) return new Decoder(stream, opts);
  debug('creating Decoder instance for ogg_stream(%d)', stream.serialno);
  Readable.call(this, opts);

  // the "ogg stream" to decode
  this._stream = stream;

  // headerin() needs to be called 3 times
  this._headerCount = 3;

  this.vi = new Buffer(binding.sizeof_vorbis_info);
  this.vc = new Buffer(binding.sizeof_vorbis_comment);
  binding.vorbis_info_init(this.vi);
  binding.vorbis_comment_init(this.vc);

  // the `vorbis_dsp_state` and `vorbis_block` stucts get allocated after the
  // headers have been parsed
  this.vd = null;
  this.vb = null;

  // set to "true" when a `vorbis_block` has been decoded, and pcm data should be
  // read
  this._blockin = false;
  // set to "true" when the `ogg_packet` with "e_o_s" marked on it is decoded
  this._gotEos = false;

  this.packetin = this.packetin.bind(this);
  stream.on('packet', this.packetin);
}
inherits(Decoder, Readable);

/**
 * Called for the stream that's being decoded's "packet" event.
 * This function passes the "ogg_packet" struct to the libvorbis backend.
 */

Decoder.prototype.packetin = function (packet, done) {
  debug('packetin()');
  var r;
  if (this._headerCount > 0) {
    debug('headerin', this._headerCount);
    // still decoding the header...
    var vi = this.vi;
    var vc = this.vc;
    binding.vorbis_synthesis_headerin(vi, vc, packet, function (r) {
      if (0 !== r) {
        //this._error(new Error('headerin() failed: ' + r));
        done(new Error('headerin() failed: ' + r));
        return;
      }
      this._headerCount--;
      if (!this._headerCount) {
        debug('done parsing Vorbis header');
        var comments = binding.comment_array(vc);
        this.comments = comments;
        this.vendor = comments.vendor;
        this.emit('comments', comments);

        var format = binding.get_format(vi);
        for (r in format) {
          this[r] = format[r];
        }
        this.emit('format', format);
        var err = this._synthesis_init();
        if (err) return done(err);
      }
      done();
    }.bind(this));
  } else if (this._blockin) {
    debug('need to wait for _read()');
    this.once('pcmout', this.packetin.bind(this, packet, done));
  } else {
    debug('synthesising ogg_packet (packetno %d)', packet.packetno);
    var vd = this.vd;
    var vb = this.vb;
    // TODO: async...
    r = binding.vorbis_synthesis(vb, packet);
    if (0 !== r) {
      this._error(new Error('vorbis_synthesis() failed: ' + r));
      process.nextTick(done);
      return;
    }
    if (packet.e_o_s) {
      this._gotEos = true;
    }
    // TODO: async...
    r = binding.vorbis_synthesis_blockin(vd, vb);
    if (0 !== r) {
      this._error(new Error('vorbis_synthesis_blockin() failed: ' + r));
      process.nextTick(done);
      return;
    }
    this._blockin = true;
    this.emit('blockin');
    process.nextTick(done);
  }
};

/**
 * Readable stream base class _read() callback function.
 *
 * @api private
 */

Decoder.prototype._read = function (bytes, done) {
  debug('_read(%d bytes)', bytes);
  if (!this._blockin) {
    debug('need to wait for "vorbis_block" to be decoded...');
    this.once('blockin', this._read.bind(this, bytes, done));
    return;
  }
  var vd = this.vd;
  var channels = this.channels;

  var b = binding.vorbis_synthesis_pcmout(vd, channels);
  if (0 === b) {
    debug('need more "vorbis_block" data...');
    this._blockin = false;
    if (this._gotEos) {
      // we're done, send EOF
      done(null, null);
    } else {
      // need to wait for another vorbis_block to be decoded
      this.once('blockin', this._read.bind(this, bytes, done));
    }
    this.emit('pcmout');
  } else if (b < 0) {
    // some other error...
    done(new Error('vorbis_synthesis_pcmout() failed: ' + b));
  } else {
    debug('got PCM data (%d bytes)', b.length);
    done(null, b);
    // need to wait for another _read() call..
  }
};

/**
 * Called once the 3 Vorbis header packets have been parsed.
 * Allocates `vorbis_dsp_state` and `vorbis_block` structs.
 * Then calls `vorbis_synthesis_init()` and `vorbis_block_init()`.
 *
 * @api private
 */

Decoder.prototype._synthesis_init = function () {
  debug('_synthesis_init()');
  this.vd = new Buffer(binding.sizeof_vorbis_dsp_state);
  this.vb = new Buffer(binding.sizeof_vorbis_block);
  var r = binding.vorbis_synthesis_init(this.vd, this.vi);
  if (0 !== r) {
    return new Error(r);
  }
  r = binding.vorbis_block_init(this.vd, this.vb);
  if (0 !== r) {
    return new Error(r);
  }
};

/**
 * Emits an "error" event and tears down the decoder.
 */

Decoder.prototype._error = function (err) {
  this._stream.removeListener('packet', this.packetin);
  this._stream = null;
  this.emit('error', err);
};
