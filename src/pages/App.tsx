import { useLocation, useNavigate } from "@solidjs/router";
import type { RendererMain } from "@solidtv/renderer";
import { activeElement, View, ElementNode, renderer } from "@solidtv/solid";
import { useMouse } from "@solidtv/solid/primitives";
import { createEffect, on, onCleanup, Show, type JSX } from "solid-js";
import { GetStarted } from "../components/GetStarted";
import { PinPrompt } from "../components/PinPrompt";
import { ReminderNotice } from "../components/ReminderNotice";
import { SignedOutNotice } from "../components/SignedOutNotice";
import { warmSection } from "../preload";
import { MENU_WIDTH, PROFILES_PATH, SideMenu } from "../components/SideMenu";
import { device } from "../device";
import { sectionEmpty, startPlace } from "../emptySection";
import { menuAway, wholeScreen } from "../wholeScreen";
import { library, profiles, sync, titleMatcher, vod } from "../library";
import { SECTIONS } from "../sections";
import { colors } from "../theme";
import { $t } from "../translate";
import { smallVideoWindow, videoFillsScreen, videoWindow } from "../videoWindow";
import { followVoiceGuide, readFocus } from "../voiceGuide";
import { ProfilePicker } from "./Profiles";
import { warmTitlesLater } from "./vod/modernTitles";
import { progressSummary } from "./settings/status";

declare module "@solidtv/solid/primitives" {
  interface KeyMap {
    Menu: string | number | (string | number)[];
    Text: string | number | (string | number)[];
    Escape: string | number | (string | number)[];
    Backspace: string | number | (string | number)[];
    ChannelUp: string | number | (string | number)[];
    ChannelDown: string | number | (string | number)[];
    Info: string | number | (string | number)[];
    ChannelList: string | number | (string | number)[];
    Guide: string | number | (string | number)[];
    Tools: string | number | (string | number)[];
  }
}

declare global {
  interface Window {
    APP: ElementNode;
  }
}

const HOLE_RADIUS = 16;

// The background's hole for the video window, or else the small window's; an
// empty hole when there's neither.
const backgroundHole = () => {
  const video = videoWindow() ?? smallVideoWindow();
  if (!video) return { x: 0, y: 0, w: 0, h: 0, radius: 0 };
  // Rounded like the cards around it, unless it fills the screen.
  const radius = video.width >= 1920 ? 0 : HOLE_RADIUS;
  return { x: video.x, y: video.y, w: video.width, h: video.height, radius };
};

// With no hole, the screen is cleared to the background's colour instead of
// drawn over with it: a quad across the whole screen took 7 of the 28 ms a
// frame of the Movies grid took on the TV's GPU (PLAN.md, "Navigation
// speed"), and a clear costs next to nothing. With a hole the clear is see-through,
// so the video shows through the background node's hole.
const hasHole = () => backgroundHole().w > 0;
/**
 * A colour as the renderer's 0xRRGGBBAA. The build turns the theme's
 * "#rrggbbaa" strings into such numbers (hexColorTransform, vite.config.js),
 * so it's a number on the TV and a string only in the tests: reading it as a
 * string on the TV threw as the app started, which left a black screen.
 */
const colorNumber = (color: string | number) =>
  typeof color === "number" ? color : Number.parseInt(color.slice(1), 16) >>> 0;
const clearBehind = (hole: boolean) =>
  // Shaders and clear colours are WebGL-only; the DOM renderer is never enabled here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  (renderer as RendererMain).setOptions({ clearColor: hole ? 0 : colorNumber(colors.background) });

// What the menu says while a source imports.
const importStatus = () => {
  const running = library.importing();
  if (!running?.source) return undefined;
  return $t("menu.updatingProgress", {
    name: running.source.name,
    progress: progressSummary(running.progress),
  });
};

const closeApp = () => {
  device.then(d => d.closeApp()).catch(error => console.error("Couldn't close the app:", error));
  return true;
};

// The app's frame: the side menu, and the current section to its right.
// Right moves from the menu into the section; Left or Back moves back out.
// Back on the menu leaves the app. While video fills the screen, the menu
// hides and Left and Back are left to the page.
/**
 * The top of the tree a node is in: the app's, unless it has been taken
 * out. A node taken out may keep its parent, which no longer has it.
 */
const topOf = (node: ElementNode) => {
  let at = node;
  for (let parent = at.parent; parent; parent = at.parent) {
    if (!parent.children.includes(at)) return at;
    at = parent;
  }
  return at;
};

/** Whether a node is `container` or inside it. */
const isInside = (node: ElementNode, container: ElementNode) => {
  for (let at: ElementNode | undefined = node; at; at = at.parent) if (at === container) return true;
  return false;
};

const App = (props: { children?: JSX.Element }) => {
  useMouse();
  const navigate = useNavigate();
  const location = useLocation();
  // The TV's voice guide reads the focus out while it's on.
  readFocus();
  device
    .then(d => followVoiceGuide(changed => d.watchVoiceGuide(changed)))
    .catch(error => console.error("Couldn't follow the voice guide:", error));

  // Movies and Series joined ahead, while nothing is being pressed.
  createEffect(() => {
    vod.films();
    vod.series();
    titleMatcher.version();
    warmTitlesLater();
  });

  const startsInSection = SECTIONS.some(section => section.path === location.pathname);
  let menu: ElementNode | undefined;
  let content: ElementNode | undefined;

  // The menu is hidden while video fills the screen, and on the full-screen
  // pages even before their video shows.
  // The profile page is one of them: the menu comes back once a profile is chosen.
  const onProfiles = () => location.pathname === PROFILES_PATH;
  const menuHidden = () =>
    videoFillsScreen() ||
    onProfiles() ||
    location.pathname === "/watch" ||
    location.pathname === "/play" ||
    menuAway();
  const focusMenu = () => {
    // On the profile page, Back or Left leaves it for Live, keeping the profile.
    if (onProfiles()) {
      navigate("/", { replace: true });
      return true;
    }
    if (menuHidden()) return false;
    menu?.setFocus();
    return true;
  };
  // A section with nothing in it (no channels, no films) leaves the keys
  // on the menu, or gives them to its ways to get started, if it offers them.
  let start: ElementNode | undefined;
  const inStart = (node: ElementNode) => !!start && !!startPlace() && isInside(node, start);
  const focusContent = () => {
    if (!sectionEmpty()) content?.setFocus();
    else if (startPlace()) start?.setFocus();
    return true;
  };
  createEffect(() => {
    if (!sectionEmpty()) return;
    const active = activeElement();
    if (active && content && isInside(active, content) && !inStart(active)) focusMenu();
  });

  // A page that goes while it has the keys, such as when another page
  // opens it, takes them with it; they come back to the menu. Pages that
  // take the keys keep them, as full-screen ones (with no menu) do.
  let check: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => location.pathname,
      () => {
        clearTimeout(check);
        check = setTimeout(() => {
          // The menu is hidden on the profile page; the picker takes the keys.
          if (onProfiles()) {
            content?.setFocus();
            return;
          }
          const active = activeElement();
          if (active && menu && topOf(active) === topOf(menu)) return;
          focusMenu();
        });
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(check));

  // Choosing a profile draws the app anew, and the picker's card that had
  // the keys goes with it: they go to the menu, or the page without one.
  let picked: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => profiles.needsPick(),
      picking => {
        clearTimeout(picked);
        if (picking) return;
        picked = setTimeout(() => {
          if (!focusMenu()) content?.setFocus();
        });
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(picked));
  createEffect(() => clearBehind(hasHole()));

  // A signed-in TV with profiles asks whose it is before anything else
  // (SYNC-PLAN.md, step 5); the pages start once one is chosen, with its data.
  return (
    <Show
      when={!profiles.needsPick()}
      fallback={
        <View ref={window.APP}>
          <View color={colors.background} />
          <ProfilePicker width={1920} autofocus />
          <PinPrompt />
        </View>
      }
    >
      <View ref={window.APP}>
        <View color={colors.background} shader={["holePunch", backgroundHole()]} alpha={hasHole() ? 1 : 0} />
        <View
          ref={element => (content = element)}
          // Under the menu for a page that lays out across the whole screen.
          x={wholeScreen() || onProfiles() ? 0 : MENU_WIDTH}
          width={wholeScreen() || onProfiles() ? 1920 : 1920 - MENU_WIDTH}
          height={1080}
          // To the page's first node, which passes it on to what should have it.
          forwardFocus={0}
          onLeft={focusMenu}
          onBack={focusMenu}
        >
          {props.children}
          {/* Over the page, which draws what it says beside them. */}
          <Show when={startPlace()}>
            {place => <GetStarted place={place()} ref={element => (start = element)} />}
          </Show>
        </View>
        <SideMenu
          ref={element => (menu = element)}
          hidden={menuHidden()}
          online={sync.connected()}
          // Only when the app opens on a section. Other pages, such as full
          // screen and developer pages, take focus themselves; and it's read
          // once, since setting it later would take the focus from a page.
          autofocus={startsInSection}
          sections={SECTIONS}
          currentPath={location.pathname}
          onSelect={path => navigate(path, { replace: true })}
          status={importStatus()}
          onPreload={warmSection}
          onRight={focusContent}
          onBack={closeApp}
          profile={profiles.current()}
        />
        <ReminderNotice />
        <SignedOutNotice />
        <PinPrompt />
      </View>
    </Show>
  );
};

export default App;
