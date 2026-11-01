// Digital Homesteaders build patch for @stoprocent/noble 2.8.0 lib/dbus/bindings.js.
//
// The D-Bus backend never listens for 'error' on its system bus connection, so a dropped or refused
// connection (EPIPE) is an unhandled 'error' event and kills the whole matter-server process.
// This adds a listener that reports the adapter as unsupported, the same state noble already uses
// when its D-Bus init fails. Fails the build when the anchor is missing, so a noble update that
// changes this code is noticed instead of silently shipping unpatched.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const anchor = "    this._bus = this._dbus.systemBus();\n";
const listener = `    this._bus.on('error', err => {
      debug('dbus connection error: %s', err && err.stack);
      this.emit('warning', \`dbus connection error: \${err && err.message}\`);
      if (this._state !== 'unsupported') {
        this._state = 'unsupported';
        this.emit('stateChange', 'unsupported');
      }
    });
`;

const source = readFileSync(file, "utf8");
if (source.includes("this._bus.on('error'")) {
    console.log(`${file}: already handles bus errors, nothing to patch`);
    process.exit(0);
}
if (source.split(anchor).length !== 2) {
    console.error(`${file}: patch anchor not found exactly once; review the noble D-Bus patch`);
    process.exit(1);
}
writeFileSync(file, source.replace(anchor, anchor + listener));
console.log(`${file}: added the D-Bus bus error listener`);
