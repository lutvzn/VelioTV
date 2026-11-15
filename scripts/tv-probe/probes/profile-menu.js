// The profile at the top of the side menu (PLAN.md, "Profile in the
// menu"): from Live, goes to the menu, Up past the sections to the
// profile, OK into the profile page, Back to the profile, Down to the
// sections. Reports after each step what has the keys and the page shown.
// Needs a signed-in TV with profiles (the sync-signin probe's "signin").
// About 6 s.
//
// Input, all optional:
//   "ups": 2     Up presses from Live, the first section

async function probe(input) {
  const { ups = 2 } = input;
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
    const path = app.focusPath();
    steps.push({
      label,
      hash: location.hash,
      onProfile: path[0] === "menuProfile",
      focus: path.slice(0, 3).join(" < "),
    });
  };

  // Two profiles ask who's watching first: the first one, as its card would.
  if (app.profiles.needsPick()) app.profiles.choose(app.profiles.list()[0].id);
  location.hash = "#/";
  await sleep(1500);
  press(KEY.left);
  await sleep(400);
  note("menu");
  for (let i = 0; i < ups; i++) {
    press(KEY.up);
    await sleep(120);
  }
  await sleep(500);
  note("ups");
  press(KEY.enter);
  await sleep(800);
  note("ok on the profile");
  press(KEY.back);
  await sleep(400);
  note("back");
  press(KEY.down);
  await sleep(700);
  note("down");
  return { profile: app.profiles.current()?.name, steps };
}
