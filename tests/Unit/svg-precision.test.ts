import { expect, test } from "bun:test";
import { svgPath } from "../../resources/js/components/orbit/svg-precision";

test("SVG paths stay identical when engines differ in floating point tail digits", () => {
    const server = "M 149.0630778703665 5.773817382593005 A 10 10 0 0 1 150 10";
    const browser = "M 149.0630778703665 5.7738173825930055 A 10 10 0 0 1 150 10";

    expect(svgPath(server)).toBe(svgPath(browser));
    expect(svgPath(server)).toBe("M 149.063078 5.773817 A 10 10 0 0 1 150 10");
});
