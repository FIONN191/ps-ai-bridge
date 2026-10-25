import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {parseShortcut,createShortcuts} from '../lib/shortcuts.mjs';
test('normalize cross-platform modifier names and reject ambiguous bindings',()=>{
  assert.deepEqual(parseShortcut('command+g'),{text:'Cmd+G',code:5,mods:256});
  assert.deepEqual(parseShortcut('shift + control + F12'),{text:'Ctrl+Shift+F12',code:111,mods:4608});
  for(const key of ['G','Shift+G','Cmd+Cmd+G','Cmd+Bad','Cmd+G+H']) assert.throws(()=>parseShortcut(key));
});
test('persist customization and preserve it after invalid updates',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ps-shortcut-test-')); const settingsFile=path.join(dir,'settings.json');
  try {
    const a=createShortcuts({settingsFile}); a.update({enabled:false,shortcut:'Cmd+Shift+G'});
    const b=createShortcuts({settingsFile}); assert.equal(b.status().shortcut,'Cmd+Shift+G'); assert.equal(b.status().enabled,false);
    assert.throws(()=>b.update({enabled:true,shortcut:'oops'})); assert.equal(b.status().enabled,false);
    assert.throws(()=>b.poll('bad')); a.stop();b.stop();
  } finally {fs.rmSync(dir,{recursive:true});}
});
