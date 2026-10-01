import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the retrieval request without credentials or a network call.
const source = fs.readFileSync(new URL('../node/server.mjs', import.meta.url), 'utf8');
const declaration = source.split('\n').find(line => line.startsWith('const retrieveResponse ='));
const expected = { output: [{ type: 'file_search_call', results: [{ filename: 'oferta.pdf', text: 'Acero B500S', score: 0.92 }] }] };
const retrieve = vm.runInNewContext(`${declaration}\nretrieveResponse`, {
  openAIRequest(method, path) {
    assert.equal(method, 'GET');
    const url = new URL(path, 'https://example.test');
    assert.equal(url.pathname, '/responses/resp_test%2F%3F');
    assert.deepEqual(url.searchParams.getAll('include[]'), ['file_search_call.results']);
    return expected;
  }
});
assert.equal(await retrieve('resp_test/?'), expected);
console.log('PASS: retrieval requests file-search results and preserves returned content.');
