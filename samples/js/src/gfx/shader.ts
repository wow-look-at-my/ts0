// Loader-backed import: the .frag text is inlined as a string at build time.
import source from "./triangle.frag";

export const triangleShader: string = source;
