// Fetches URLs from the app with fetch() and XHR, to see whether the TV
// enforces CORS and how long downloads take.
//
// Input: { "urls": ["https://..."] }

async function probe(input) {
  const withFetch = async url => {
    const started = performance.now();
    try {
      const response = await fetch(url);
      const body = await response.text();
      return `fetch ${response.status}, ${body.length} chars, ${Math.round(performance.now() - started)} ms`;
    } catch (error) {
      return `fetch failed: ${error.name}: ${error.message}`;
    }
  };
  const withXhr = url =>
    new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.addEventListener("load", () => resolve(`xhr ${xhr.status}, ${xhr.responseText.length} chars`));
      xhr.addEventListener("error", () => resolve("xhr failed"));
      xhr.send();
    });

  const results = { origin: location.origin };
  for (const url of input.urls) results[url] = [await withFetch(url), await withXhr(url)];
  return results;
}
