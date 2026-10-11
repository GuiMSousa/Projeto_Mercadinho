// Teste de contrato: openspec/openapi.yaml e as rotas registradas no Express
// precisam descrever exatamente a mesma API. Rota nova sem documentação (ou
// documentação de rota que não existe) quebra este teste. Não usa banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const app = require('../src/app');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function documentedOperations() {
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'openspec', 'openapi.yaml'), 'utf8'));
  return Object.entries(spec.paths)
    .flatMap(([route, item]) => HTTP_METHODS.filter((m) => item[m]).map((m) => `${m.toUpperCase()} ${route}`))
    .sort();
}

function registeredOperations() {
  // shortcut: lê app._router (interno do Express 4); no Express 5 vira app.router.
  return app._router.stack
    .filter((layer) => Array.isArray(layer.handle?.stack)) // só os roteadores montados com app.use
    .flatMap((layer) => {
      // "^\/api\/auth\/?(?=\/|$)" → "/api/auth"
      const prefix = layer.regexp.source.replace(/^\^/, '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
      return layer.handle.stack
        .filter((routeLayer) => routeLayer.route)
        .flatMap(({ route }) => {
          const fullPath = (prefix + (route.path === '/' ? '' : route.path)).replace(/:(\w+)/g, '{$1}');
          return Object.keys(route.methods).map((m) => `${m.toUpperCase()} ${fullPath}`);
        });
    })
    .sort();
}

test('openapi.yaml documenta exatamente as rotas registradas no Express', () => {
  const registered = registeredOperations();
  assert.ok(registered.length > 0, 'nenhuma rota encontrada — a leitura do roteador do Express quebrou');
  assert.deepEqual(documentedOperations(), registered);
});
