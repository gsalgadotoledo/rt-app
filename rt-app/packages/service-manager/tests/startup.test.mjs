import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchAgent} from '../electron/startup.mjs';
test('login agent quotes executable and PATH, starts hidden, and never persists credentials',()=>{
 const plist=launchAgent('/Applications/RT & App.app/Contents/MacOS/RT-App','/bin:/a<b');
 assert.match(plist,/RT &amp; App/);assert.match(plist,/\/a&lt;b/);assert.match(plist,/<string>--background<\/string>/);
 assert.match(plist,/<key>RunAtLoad<\/key><true\/>/);assert.doesNotMatch(plist,/PASSWORD|SECRET|KeepAlive|sudo/);
});
