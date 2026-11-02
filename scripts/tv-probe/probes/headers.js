// Tests whether the app can send custom Referer and User-Agent headers with
// fetch() and XHR. If it can, a player that downloads segments itself (such
// as Shaka) could play streams that need those headers.
//
// Input: { "index": "http://<test-stream-server>/" }, the index of
// scripts/test-streams/server.mjs, whose header tests answer 403 without
// the right header.

async function probe(input) {
  const index = await (await fetch(input.index)).json();

  const withFetch = async (url, header, value) => {
    try {
      const options = header === "Referer" ? { referrer: value } : { headers: { [header]: value } };
      return `fetch ${(await fetch(url, options)).status}`;
    } catch (error) {
      return `fetch failed: ${error.name}: ${error.message}`;
    }
  };
  const withXhr = (url, header, value) =>
    new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      try {
        xhr.setRequestHeader(header, value);
      } catch (error) {
        resolve(`xhr refused the header: ${error.message}`);
        return;
      }
      xhr.addEventListener("load", () => resolve(`xhr ${xhr.status}`));
      xhr.addEventListener("error", () => resolve("xhr failed"));
      xhr.send();
    });

  const results = {};
  for (const test of index.headerTests) {
    results[test.header] = [
      await withFetch(test.hls, test.header, test.value),
      await withXhr(test.hls, test.header, test.value),
    ];
  }
  return results;
}
