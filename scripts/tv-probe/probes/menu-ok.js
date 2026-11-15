// The side menu opens a section only on OK (PLAN.md, "Menu opens on OK"):
// from Live, goes to the menu, Down to Movies, waits, and reports the page
// (it should still be Live), then OK (it should open Movies). About 5 s.

async function probe() {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const KEY = { left: 37, down: 40, enter: 13 };
  const steps = [];
  const note = label => steps.push({ label, hash: location.hash });

  location.hash = "#/";
  await sleep(1200);
  press(KEY.left);
  await sleep(500);
  note("menu");
  press(KEY.down);
  await sleep(1000);
  note("down, waited 1 s");
  press(KEY.enter);
  await sleep(1200);
  note("ok");
  return { steps };
}
