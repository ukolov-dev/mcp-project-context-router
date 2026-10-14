import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { discoverCapabilities } from '../src/indexer/capabilities.js';
import { ensureFreshIndex, openDb, rebuildIndex } from '../src/indexer/sqlite.js';
import { findExistingCapability } from '../src/reuse-scan/reuse.js';

let previousCwd: string;
let root: string;
beforeEach(() => {
  previousCwd = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'context-language-test-'));
  process.chdir(root);
  mkdirSync('src');
  mkdirSync('.project-context');
  writeFileSync('.project-context/project.yaml', 'project:\n  name: Language fixtures\nrouting:\n  default_modules: [app]\nmodules:\n  app:\n    path: src\ncommands: {}\n');
});
afterEach(() => { process.chdir(previousCwd); rmSync(root, { recursive: true, force: true }); });
const write = (extension: string, text: string) => writeFileSync(`src/sample.${extension}`, text);
const symbols = () => discoverCapabilities().capabilities;

describe('Python declarations', () => {
  it('recognizes decorated, async, generic and multiline definitions, class methods and explicit aliases', () => {
    write('py', `from typing import TypeAlias
class Customer:
    @staticmethod
    async def load_customer(
        customer_id: int,
    ) -> str:
        def local_helper():
            return "value"
        return local_helper()
    def _private(self): pass
def save_customer[T](value: T): pass
class _Internal: pass
type CustomerId = int
CustomerMap: TypeAlias = dict[int, Customer]
Legacy: typing.TypeAlias = Customer
class Box[T](
    Generic[T],
): pass
def café(): pass
`);
    expect(symbols().map(item => [item.name, item.kind, item.exported])).toEqual([
      ['Customer', 'class', true], ['load_customer', 'method', true], ['local_helper', 'function', false],
      ['_private', 'method', false], ['save_customer', 'function', true], ['_Internal', 'class', false],
      ['CustomerId', 'type', true], ['CustomerMap', 'type', true], ['Legacy', 'type', true],
      ['Box', 'class', true], ['café', 'function', true],
    ]);
    expect(symbols().find(item => item.name === 'load_customer')).toMatchObject({ lineStart: 4, lineEnd: 6 });
  });

  it('ignores comments, docstrings, quoted text and continued expressions without losing later definitions', () => {
    write('py', `# def fake(): pass
text = r"""
class Fake:
    def phantom(): pass
"""
escaped = "def invisible(): pass"
continued = (
    "type Ghost = str"
)
class Real:
    """class Wrong: pass"""
    def run(self): pass
def after(): pass
`);
    expect(symbols().map(item => item.name)).toEqual(['Real', 'run', 'after']);
    expect(discoverCapabilities().endpoints).toEqual([]);
  });
});

describe('Go declarations', () => {
  it('recognizes functions, generic receivers, exported types, aliases and grouped types without duplicates', () => {
    write('go', `package sample
type Customer struct { ID int }
type Repository[T any] interface { Load(int) T }
type CustomerID = int
type (
    Result[T any] struct { Value T }
    Callback func(int) string
    privateID int
)
func LoadCustomers[T any](
    values []T,
) []T { return values }
func (customer *Customer) SaveCustomer() {}
func(customer *Customer) privateMethod() {}
func privateFunction() {}
func External()
func
Multiline() {}
var factory = funcFactory()
`);
    expect(symbols().map(item => [item.name, item.kind, item.exported])).toEqual([
      ['Customer', 'struct', true], ['Repository', 'interface', true], ['CustomerID', 'type', true],
      ['Result', 'struct', true], ['Callback', 'type', true], ['privateID', 'type', false],
      ['LoadCustomers', 'function', true], ['SaveCustomer', 'method', true], ['privateMethod', 'method', false],
      ['privateFunction', 'function', false], ['External', 'function', true], ['Multiline', 'function', true],
    ]);
    expect(symbols().find(item => item.name === 'LoadCustomers')).toMatchObject({ lineStart: 10, lineEnd: 12 });
  });

  it('ignores raw strings, comments, function literals and struct fields in grouped type declarations', () => {
    write('go', 'package sample\n/* type Fake struct {} */\n// func Fake() {}\nvar raw = `\nfunc Ghost() {}\ntype GhostType int\n`\nvar literal = func() {}\ntype (\n  Real struct {\n    Field int\n    Callback func()\n  }\n  Alias = Real\n)\nfunc After() {}\n');
    expect(symbols().map(item => item.name)).toEqual(['Real', 'Alias', 'After']);
  });
});

describe('Rust declarations', () => {
  it('recognizes items, qualifiers, raw identifiers, lifetimes, methods and declared visibility', () => {
    write('rs', `pub struct Customer<'a> { name: &'a str }
pub enum State { Active, Disabled }
pub trait Repository { fn load_customer(&self); type Item; }
pub union Storage { number: u32 }
pub type CustomerId = u64;
pub(crate) struct Internal;
impl<'a> Customer<'a> {
    pub async fn save_customer(
        &self,
    ) -> Result<(), Error> { Ok(()) }
    fn private_method(&self) {}
}
pub unsafe extern "C" fn external() {}
const fn private_function() {}
pub fn r#match() {}
`);
    expect(symbols().map(item => [item.name, item.kind, item.exported])).toEqual([
      ['Customer', 'struct', true], ['State', 'enum', true], ['Repository', 'trait', true],
      ['load_customer', 'method', true], ['Item', 'type', true], ['Storage', 'union', true],
      ['CustomerId', 'type', true], ['Internal', 'struct', false], ['save_customer', 'method', true],
      ['private_method', 'method', false], ['external', 'function', true], ['private_function', 'function', false],
      ['match', 'function', true],
    ]);
    expect(symbols().find(item => item.name === 'save_customer')).toMatchObject({ lineStart: 8, lineEnd: 10 });
  });

  it('ignores nested comments, raw strings, char literals, attributes and macro token trees', () => {
    write('rs', `/* outer /* nested */ pub fn ghost() {} */
const RAW: &str = r##"pub fn fake() {} struct Fake {}"##;
const CHARACTER: char = '{';
macro_rules! generated { () => { pub fn ghost_macro() {} }; }
generate! { pub struct Generated; fn generated_function() {} }
макрос! { fn unicode_macro_ghost() {} }
#[doc = "fn documentation() {}"]
pub struct Real;
impl Real { pub fn run(&self) { let ch = '}'; } }
pub fn after<'a>(value: &'a str) -> &'a str { value }
`);
    expect(symbols().map(item => item.name)).toEqual(['Real', 'run', 'after']);
  });
});

describe('native language index integration', () => {
  it.each([
    ['py', 'def load_customer(): pass\n', 'def save_customer(): pass\n', 'load_customer', 'save_customer'],
    ['go', 'package sample\nfunc LoadCustomer() {}\n', 'package sample\nfunc SaveCustomer() {}\n', 'LoadCustomer', 'SaveCustomer'],
    ['rs', 'pub fn load_customer() {}\n', 'pub fn save_customer() {}\n', 'load_customer', 'save_customer'],
  ])('indexes %s symbols for reuse and context packs and refreshes changed source', (extension, initial, changed, oldName, newName) => {
    write(extension, initial);
    expect(rebuildIndex().symbols).toBe(1);
    expect(findExistingCapability(oldName, ['app']).matches).toContainEqual(expect.objectContaining({ name: oldName, path: `src/sample.${extension}` }));
    expect(buildContextPack({ query: oldName, modules: ['app'] }).files.map(item => item.path)).toContain(`src/sample.${extension}`);
    write(extension, changed);
    expect(ensureFreshIndex({ force: true }).status).toBe('rebuilt');
    expect(findExistingCapability(newName, ['app']).matches.map(item => item.name)).toContain(newName);
    expect(findExistingCapability(oldName, ['app']).matches).toEqual([]);
  });

  it.each([
    ['py', '# comment\r\ndef load_customer(): pass'],
    ['go', 'package sample\r\nfunc LoadCustomer() {}'],
    ['rs', '// comment\r\npub fn load_customer() {}'],
  ])('keeps source line positions for %s CRLF files without a final newline', (extension, source) => {
    write(extension, source);
    expect(symbols()).toHaveLength(1);
    expect(symbols()[0]).toMatchObject({ lineStart: 2, lineEnd: 2 });
  });

  it('refreshes an unchanged consumer index built by the previous extractor version', () => {
    const source = 'def load_customer(): pass\n';
    write('py', source);
    rebuildIndex();
    const stat = statSync('src/sample.py');
    const oldState = createHash('sha256').update('csharp-v1').update('app').update('\0').update('src/sample.py').update('\0')
      .update(`${stat.size}:${stat.mtimeMs}`).update('\0').digest('hex');
    const db = openDb();
    try {
      db.exec('DELETE FROM symbols');
      db.prepare('UPDATE index_metadata SET value = ? WHERE key = ?').run(oldState, 'capability_source_state');
    } finally { db.close(); }
    expect(ensureFreshIndex({ force: true }).status).toBe('rebuilt');
    expect(findExistingCapability('load_customer', ['app']).matches.map(item => item.name)).toContain('load_customer');
  });
});
