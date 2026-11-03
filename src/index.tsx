import { createRenderer, Config as LightningConfig, loadFonts } from "@solidtv/solid";
import { Route } from "@solidjs/router";
import { useFocusManager } from "@solidtv/solid/primitives";
import { HashRouter } from "@solidtv/solid/primitives/router";
import type { RendererMain } from "@solidtv/renderer";
import App from "./pages/App";
import LiveTv from "./pages/LiveTv";
import Guide from "./pages/Guide";
import Movies from "./pages/Movies";
import Series from "./pages/Series";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import VideoTest from "./pages/dev/VideoTest";
import fonts from "./fonts";
import { merge } from "lodash-es";
import { config } from "./device";
import { installDevHooks } from "./devHooks";
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

loadFonts(fonts).catch(error => console.error("Fonts failed to load:", error));
render(() => {
  useFocusManager(config.keys);
  return (
    <HashRouter root={App}>
      <Route path="/" component={LiveTv} />
      <Route path="/guide" component={Guide} />
      <Route path="/movies" component={Movies} />
      <Route path="/series" component={Series} />
      <Route path="/settings" component={Settings} />
      <Route path="/dev/video" component={VideoTest} />
      <Route path="/*all" component={NotFound} />
    </HashRouter>
  );
});
