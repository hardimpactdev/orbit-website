// Keep SVG attributes identical across JavaScript engines without visible rounding.
export const svgNumber = (value: number) => Number(value.toFixed(6));

export const svgPath = (path: string) =>
    path.replace(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, (value) => String(svgNumber(Number(value))));
