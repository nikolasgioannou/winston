// noVNC 1.7 exports its RFB client as the package root; the DefinitelyTyped
// types still name the old `lib/rfb` path.
declare module "@novnc/novnc" {
  import RFB from "@novnc/novnc/lib/rfb";
  export default RFB;
}
