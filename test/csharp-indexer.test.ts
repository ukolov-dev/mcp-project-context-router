import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { discoverCapabilities } from '../src/indexer/capabilities.js';
import { ensureFreshIndex, openDb, rebuildIndex } from '../src/indexer/sqlite.js';
import { findExistingCapability } from '../src/reuse-scan/reuse.js';

let originalCwd: string;
let root: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'context-csharp-test-'));
  process.chdir(root);
  mkdirSync('src');
  mkdirSync('.project-context', { recursive: true });
  writeFileSync('.project-context/project.yaml', `project:
  name: CSharp sample
routing:
  default_modules: [api]
modules:
  api:
    path: src
    aliases: [customers]
commands:
  build: dotnet build
`);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

function source(text: string, path = 'src/Sample.cs') {
  writeFileSync(path, text);
}

describe('C# capability discovery', () => {
  it('discovers types and members with correct source lines, without duplicate Java symbols', () => {
    source(`namespace Sample;
public record Customer(int Id);
public readonly record struct CustomerKey(int Id);
internal enum State { Active, Disabled }
public struct Point { public int X { get; init; } }
public interface IRepository<T>
{
    Task<T> FindAsync(int id);
    int Count { get; }
}
public partial class CustomerService<T> where T : class
{
    public CustomerService() { }
    public async Task<List<T>>
        LoadAsync(int id) { return null; }
    protected virtual T Find(int id) => default;
    private string Secret => "value";
    public string Name { get; set; }
    public int Field = 3;
    public class Nested { public void Run() { } }
}
`);
    const { capabilities } = discoverCapabilities();
    expect(capabilities.map((item) => [item.name, item.kind])).toEqual([
      ['Customer', 'record'], ['CustomerKey', 'record'], ['State', 'enum'],
      ['Point', 'struct'], ['X', 'property'], ['IRepository', 'interface'],
      ['FindAsync', 'method'], ['Count', 'property'], ['CustomerService', 'class'],
      ['CustomerService', 'constructor'], ['LoadAsync', 'method'], ['Find', 'method'],
      ['Secret', 'property'], ['Name', 'property'], ['Nested', 'class'], ['Run', 'method'],
    ]);
    expect(capabilities.find((item) => item.name === 'LoadAsync')).toMatchObject({
      filePath: 'src/Sample.cs', module: 'api', lineStart: 14, lineEnd: 15, exported: true,
    });
    expect(capabilities.find((item) => item.name === 'State')?.exported).toBe(false);
    expect(capabilities.find((item) => item.name === 'FindAsync')?.exported).toBe(true);
    expect(capabilities.find((item) => item.name === 'Secret')?.exported).toBe(false);
  });

  it('ignores comments, strings and local functions while keeping surrounding declarations', () => {
    source(`/* public class Ghost { [HttpGet("/ghost")] public void Bad() {} } */
// public class AnotherGhost {}
public class Real
{
    public string Text = @"public class StringGhost { }";
    public string Raw = """
public class RawGhost { [HttpGet("/fake")] public void Bad() {} }
""";
    public void Execute()
    {
        string value = "public class QuotedGhost { }";
        char brace = '}';
        void Local() { }
    }
    public int Count => 2;
}
`);
    const result = discoverCapabilities();
    expect(result.capabilities.map((item) => item.name)).toEqual(['Real', 'Execute', 'Count']);
    expect(result.endpoints).toEqual([]);
  });

  it('extracts controller routes, verb attributes, absolute paths and action tokens', () => {
    source(`[Route("api/[controller]")]
public class CustomersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public async Task<Customer> FindAsync(int id) => null;
    [HttpPost]
    [Route("[action]")]
    public void CreateAsync() { }
    [HttpDelete("~/customers/{id}")]
    public void Delete(int id) { }
    [HttpHead("/health"), HttpOptions("/health")]
    public void Health() { }
    [NonAction, HttpGet("ignored")]
    public void Helper() { }
    [HttpGet("private")]
    private void Private() { }
}
public class OtherController
{
    [HttpGet("other")]
    public void List() { }
    [HttpGet]
    public void Conventional() { }
}
`);
    const { capabilities, endpoints } = discoverCapabilities();
    expect(endpoints.map((item) => [item.method, item.path])).toEqual([
      ['GET', '/api/Customers/{id:int}'], ['POST', '/api/Customers/Create'],
      ['DELETE', '/customers/{id}'], ['HEAD', '/health'], ['OPTIONS', '/health'], ['GET', '/other'],
    ]);
    expect(endpoints[0].controllerSymbolId).toBe(capabilities.find((item) => item.name === 'CustomersController')?.id);
  });

  it('handles multiline attributes, multiple base routes and unsupported computed routes conservatively', () => {
    source(`[Route(
    @"v1/[controller]", Name = "v1")]
[Route("v2/[controller]")]
public class ProductsController
{
    [HttpGet]
    [Route("[action]")]
    [ActionName("Browse")]
    public void List() { }
    [HttpGet(Routes.Computed)]
    public void Computed() { }
    [HttpPut("save")]
    public static void Static() { }
}
[Route(Routes.Computed)]
public class ComputedController
{
    [HttpGet("local")]
    public void Local() { }
    [HttpGet("/absolute")]
    public void Absolute() { }
}
`);
    expect(discoverCapabilities().endpoints.map((item) => item.path)).toEqual([
      '/v1/Products/Browse', '/v2/Products/Browse', '/absolute',
    ]);
  });

  it('makes C# discoveries available in SQLite, reuse scans and context packs, and refreshes edits', () => {
    source('[Route("customers")] public class CustomersController { [HttpGet] public void LoadCustomers() {} }');
    expect(rebuildIndex()).toMatchObject({ symbols: 2, endpoints: 1 });
    const db = openDb();
    try {
      expect(db.prepare('SELECT method, path FROM endpoints').all()).toEqual([{ method: 'GET', path: '/customers' }]);
    } finally { db.close(); }
    expect(findExistingCapability('LoadCustomers', ['api']).matches).toContainEqual(expect.objectContaining({
      name: 'LoadCustomers', kind: 'method', path: 'src/Sample.cs',
    }));
    expect(buildContextPack({ query: 'LoadCustomers', modules: ['api'] }).files.map((file) => file.path)).toContain('src/Sample.cs');
    source('public class CustomerService { public void SaveCustomers() {} }');
    expect(ensureFreshIndex({ force: true }).status).toBe('rebuilt');
    expect(findExistingCapability('SaveCustomers', ['api']).matches.map((item) => item.name)).toContain('SaveCustomers');
    expect(findExistingCapability('LoadCustomers', ['api']).matches).toEqual([]);
  });

  it('refreshes an existing index built with the old discovery rules even if sources are unchanged', () => {
    source('public class CustomerService { public void SaveCustomers() {} }');
    rebuildIndex();
    const stat = statSync('src/Sample.cs');
    const legacyState = createHash('sha256').update('api').update('\0').update('src/Sample.cs').update('\0')
      .update(`${stat.size}:${stat.mtimeMs}`).update('\0').digest('hex');
    const db = openDb();
    try {
      db.prepare('DELETE FROM symbols WHERE kind = ?').run('method');
      db.prepare('UPDATE index_metadata SET value = ? WHERE key = ?').run(legacyState, 'capability_source_state');
    } finally { db.close(); }
    expect(ensureFreshIndex({ force: true }).status).toBe('rebuilt');
    expect(findExistingCapability('SaveCustomers', ['api']).matches.map((item) => item.name)).toContain('SaveCustomers');
  });

  it('keeps route punctuation literal and distinguishes explicit empty routes from conventional actions', () => {
    source(`public class LiteralController
{
    [HttpGet("{id:regex(^[0-9]+$)}")]
    public void Regex() { }
    [Microsoft.AspNetCore.Mvc.HttpPostAttribute("")]
    public void Root() { }
    [HttpGet]
    public void Conventional() { }
    [HttpPut($"computed/{Value}")]
    public void Computed() { }
}
`);
    expect(discoverCapabilities().endpoints.map((item) => [item.method, item.path])).toEqual([
      ['GET', '/{id:regex(^[0-9]+$)}'], ['POST', '/'],
    ]);
  });

  it('preserves discovery for TypeScript, Java/Spring and Markdown', () => {
    source('export function loadCustomers() {}', 'src/client.ts');
    source('@RequestMapping("/java")\npublic class JavaController {\n@GetMapping("/customers")\n}', 'src/JavaController.java');
    source('# Customer guide', 'src/guide.md');
    const { capabilities, endpoints } = discoverCapabilities();
    expect(capabilities.map((item) => item.name)).toEqual(expect.arrayContaining(['loadCustomers', 'JavaController', 'Customer guide']));
    expect(endpoints).toContainEqual(expect.objectContaining({ method: 'GET', path: '/java/customers' }));
  });
});
