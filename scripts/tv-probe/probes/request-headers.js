// Which request headers the app can really send, as the test server's /echo
// sees them. Stalker portals need `Cookie: mac=...` and often a MAG
// User-Agent, and browsers usually refuse to let scripts set either.
//
// Input:
//   "echo": "http://<dev-ip>:8090/echo"

async function probe(input) {
  const wanted = {
    Cookie: "mac=00:1A:79:00:00:01; stb_lang=en; timezone=UTC",
    "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
    "X-User-Agent": "Model: MAG250; Link: WiFi",
    Authorization: "Bearer TEST",
    Referer: "http://velio.test/",
  };
  // Which of the wanted headers arrived, and with what value.
  const arrived = headers =>
    Object.fromEntries(
      Object.entries(wanted).map(([name, value]) => {
        const got = headers[name.toLowerCase()];
        return [name, got === value ? "sent" : got ? `changed: ${got}` : "missing"];
      }),
    );

  const results = {};
  try {
    const response = await fetch(input.echo, { headers: wanted, credentials: "include" });
    results.fetch = arrived((await response.json()).headers);
  } catch (error) {
    results.fetch = `${error.name}: ${error.message}`;
  }
  results.xhr = await new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", input.echo);
    xhr.withCredentials = true;
    const refused = [];
    for (const [name, value] of Object.entries(wanted)) {
      try {
        xhr.setRequestHeader(name, value);
      } catch {
        refused.push(name);
      }
    }
    xhr.addEventListener("load", () =>
      resolve({ ...arrived(JSON.parse(xhr.responseText).headers), refused }),
    );
    xhr.addEventListener("error", () => resolve("request failed"));
    xhr.send();
  });
  // Whether a cookie the app sets for its own page reaches another host.
  document.cookie = "mac=00:1A:79:00:00:01";
  results.documentCookie = document.cookie;
  results.userAgent = navigator.userAgent;
  return results;
}
