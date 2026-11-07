import { createRenderer, Config as LightningConfig, loadFonts } from "@solidtv/solid";
import { Route } from "@solidjs/router";
import { useFocusManager } from "@solidtv/solid/primitives";
import { HashRouter } from "@solidtv/solid/primitives/router";
import type { RendererMain } from "@solidtv/renderer";
import App from "./pages/App";
import Guide from "./pages/Guide";
import Watch from "./pages/Watch";
import Movies from "./pages/Movies";
import Series from "./pages/Series";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import VideoTest from "./pages/dev/VideoTest";
import fonts from "./fonts";
import { merge } from "lodash-es";
import { config } from "./device";
import { installDevHooks } from "./devHooks";
import { library, settings } from "./library";
import { player } from "./player";
import { watchLifecycle } from "./player/lifecycle";
import {
  Rounded,
  RoundedWithShadow,
  RoundedWithBorder,
  RoundedWithBorderAndShadow,
  RadialGradient,
  LinearGradient,
  HolePunch,
} from "@solidtv/renderer/shaders";

merge(LightningConfig, config.lightning);
installDevHooks();
watchLifecycle(player);

const { render, renderer } = createRenderer();

// Shaders are WebGL-only; the DOM renderer is never enabled here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const shaders = renderer as RendererMain;
shaders.registerShaderType("rounded", Rounded);
shaders.registerShaderType("roundedWithBorder", RoundedWithBorder);
shaders.registerShaderType("roundedWithShadow", RoundedWithShadow);
shaders.registerShaderType("roundedWithBorderWithShadow", RoundedWithBorderAndShadow);
shaders.registerShaderType("radialGradient", RadialGradient);
shaders.registerShaderType("linearGradient", LinearGradient);
shaders.registerShaderType("holePunch", HolePunch);

// Imports sources whose data is old or missing, now and on a schedule.
library.start().catch(error => console.error("Couldn't start the source schedule:", error));

// The app opens full screen on the last channel watched, with Live TV, the
// guide, a Back away, or on the guide if Settings says so.
if ((!location.hash || location.hash === "#/") && settings.startOn() === "last") location.replace("#/watch");

loadFonts(fonts).catch(error => console.error("Fonts failed to load:", error));
render(() => {
  useFocusManager(config.keys);
  return (
    <HashRouter root={App}>
      <Route path="/" component={Guide} />
      <Route path="/watch" component={Watch} />
      <Route path="/movies" component={Movies} />
      <Route path="/series" component={Series} />
      <Route path="/settings" component={Settings} />
      <Route path="/dev/video" component={VideoTest} />
      <Route path="/*all" component={NotFound} />
    </HashRouter>
  );
});
