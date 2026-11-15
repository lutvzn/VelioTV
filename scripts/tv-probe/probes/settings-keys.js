// Drives Settings by key presses (PLAN.md, "Settings by category"): opens it
// from the menu, moves down the categories, goes into the panel and back,
// and reports after each step the category shown, the column's cursor,
// whether the panel has the keys, and how deep the focus is. About 6 s.
//
// Input, all optional:
//   "downs": 3     Down presses in the column before going into the panel
//   "back": false  leave the column with Back instead of Left (to check it
//                  reaches the menu and doesn't close the app)

async function probe(input) {
  const { downs = 3, back = false } = input;
  const app = window.velio;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const press = keyCode => {
    for (const type of ["keydown", "keyup"]) {
      document.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
    }
  };
  const KEY = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 10009 };
  const steps = [];
  const note = label => {
    const page = app.settingsPage;
    steps.push({
      label,
      category: page?.category(),
      cursor: page?.cursor(),
      inPane: page?.inPane(),
      // How deep the focus is: the column is Settings' own node; the panel's fields are deeper.
      focusDepth: app.focusPath().length,
    });
  };

  location.hash = "#/settings";
  await sleep(1200);
  note("opened");
  // The menu has the keys; Right goes into Settings' column.
  press(KEY.right);
  await sleep(400);
  note("right from menu");
  for (let i = 0; i < downs; i++) {
    press(KEY.down);
    await sleep(120);
  }
  note("downs, moving");
  await sleep(600);
  note("downs, rested");
  press(KEY.right);
  await sleep(500);
  note("right into panel");
  press(KEY.down);
  await sleep(300);
  note("down in panel");
  press(KEY.left);
  await sleep(400);
  note("left to column");
  press(KEY.enter);
  await sleep(400);
  note("ok into panel");
  press(KEY.back);
  await sleep(400);
  note("back to column");
  press(KEY.up);
  await sleep(700);
  note("up, rested");
  press(back ? KEY.back : KEY.left);
  await sleep(400);
  note(back ? "back to menu" : "left to menu");
  return { steps };
}
