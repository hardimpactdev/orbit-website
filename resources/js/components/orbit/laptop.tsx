import { cancelScrollFrame, observeScroll, requestScrollFrame } from "./animation";
import { observeSceneActivity } from "./animation";
import { useEffect, useRef, useState } from "react";
import { objectTransform, scalePoint } from "./object-scale";
import { laptopCloseStart, storyEntranceEnd, storyLayoutBounds } from "./story-entrance";
import { useSceneViewport } from "./use-scene-viewport";

import { svgPath } from "./svg-precision";

type Phase = "running" | "closing" | "sleeping" | "opening";
const width = 300;
const depth = 200;
const bodyThickness = 10;
const lidThickness = 4;
const laptopRadius = 10;
const hingeX = 268;
const hingeY = 272;
const openAngle = Math.PI / 2;
const processLabelScale = 0.85;
const processTextX = 25;
const processLabelVisualBottom = 25 * processLabelScale;
const processConnectionGap = 12;
const queueLabelOffset = processConnectionGap - processLabelScale;

// An orthographic camera, turned toward the display. All surfaces use this
// same projection, so the gentler viewing angle never introduces perspective taper.
const azimuth = (25 * Math.PI) / 180;
const elevation = (30 * Math.PI) / 180;
const axisX = [Math.cos(azimuth), Math.sin(azimuth) * Math.sin(elevation)];
const axisY = [-Math.sin(azimuth), Math.cos(azimuth) * Math.sin(elevation)];
const axisZ = -Math.cos(elevation);
const deckTransform = `matrix(${axisX[0]} ${axisX[1]} ${axisY[0]} ${axisY[1]} ${hingeX} ${hingeY})`;

export function hardwarePlane(x: number, y: number) {
    return `matrix(${axisX[0]} ${axisX[1]} ${axisY[0]} ${axisY[1]} ${x} ${y})`;
}

export function hardwarePoint(x: number, y: number): [number, number] {
    return [axisX[0] * x + axisY[0] * y, axisX[1] * x + axisY[1] * y];
}

type Point = [number, number];
const lidCornerCenters: Point[] = [
    [width - laptopRadius, laptopRadius],
    [width - laptopRadius, depth - laptopRadius],
    [laptopRadius, depth - laptopRadius],
    [laptopRadius, laptopRadius],
];

function convexHull(points: Point[]) {
    const sorted = points.toSorted(([ax, ay], [bx, by]) => ax - bx || ay - by);
    const cross = (a: Point, b: Point, c: Point) =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const half = (vertices: Point[]) => {
        const hull: Point[] = [];
        for (const point of vertices) {
            while (
                hull.length > 1 &&
                cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0
            )
                hull.pop();
            hull.push(point);
        }
        return hull.slice(0, -1);
    };
    return [...half(sorted), ...half(sorted.toReversed())];
}

const pointString = ([x, y]: Point) => `${x.toFixed(3)} ${y.toFixed(3)}`;

function roundedLidOutline(centers: Point[], c: number, d: number) {
    const hull = convexHull(centers);
    const determinant = axisX[0] * d - axisX[1] * c;
    const ellipse = (angle: number): Point => [
        laptopRadius * (axisX[0] * Math.cos(angle) + c * Math.sin(angle)),
        laptopRadius * (axisX[1] * Math.cos(angle) + d * Math.sin(angle)),
    ];
    // Offset the tiny (six-vertex) hull by the projected corner circle.
    // A handful of cubic arcs replaces sorting/serializing 200 points per frame.
    const angles = hull.map((point, index) => {
        const next = hull[(index + 1) % hull.length];
        const nx = next[1] - point[1];
        const ny = point[0] - next[0];
        return Math.atan2(c * nx + d * ny, axisX[0] * nx + axisX[1] * ny);
    });
    const commands: string[] = [];
    hull.forEach(([x, y], index) => {
        const start = angles[(index + hull.length - 1) % hull.length];
        const end = angles[index];
        const turn = Math.PI * 2;
        let sweep = (((end - start) % turn) + turn) % turn;
        if (sweep < 1e-9 || turn - sweep < 1e-9) sweep = 0;
        if (determinant < 0 && sweep > 0) sweep -= turn;
        const point = (angle: number): Point => {
            const [ex, ey] = ellipse(angle);
            return [x + ex, y + ey];
        };
        commands.push(`${index === 0 ? "M" : "L"} ${pointString(point(start))}`);
        const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
        for (let step = 0; step < steps; step++) {
            const a = start + (sweep * step) / steps;
            const b = start + (sweep * (step + 1)) / steps;
            const factor = (4 / 3) * Math.tan((b - a) / 4);
            const from = point(a);
            const to = point(b);
            const da = ellipse(a + Math.PI / 2);
            const db = ellipse(b + Math.PI / 2);
            commands.push(
                `C ${pointString([from[0] + factor * da[0], from[1] + factor * da[1]])} ${pointString([to[0] - factor * db[0], to[1] - factor * db[1]])} ${pointString(to)}`,
            );
        }
    });
    return `${commands.join(" ")} Z`;
}

export function lidGeometry(angle: number, thickness = lidThickness) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const c = -axisY[0] * cosine;
    const d = -axisY[1] * cosine - axisZ * sine;
    const e = hingeX - depth * c;
    const f = hingeY - 2 - depth * d;
    const offsetX = -axisY[0] * sine * thickness;
    const offsetY = (-axisY[1] * sine + axisZ * cosine) * thickness;
    const points = lidCornerCenters.map(([x, y]): Point => [
        e + x * axisX[0] + y * c,
        f + x * axisX[1] + y * d,
    ]);
    // A projected solid's silhouette is the hull of its two rounded faces.
    // This remains well-defined when the lid is edge-on (no matrix inversion).
    const edge = roundedLidOutline(
        [...points, ...points.map(([x, y]): Point => [x + offsetX, y + offsetY])],
        c,
        d,
    );

    return {
        front: `matrix(${axisX[0]} ${axisX[1]} ${c} ${d} ${e} ${f})`,
        back: `matrix(${axisX[0]} ${axisX[1]} ${c} ${d} ${e + offsetX} ${f + offsetY})`,
        edge,
        frontFacing: axisX[0] * d - axisX[1] * c > 0,
    };
}

const initialLid = lidGeometry(openAngle);
const closedLid = lidGeometry(0);
const modelScale = 1.18;
const modelOffset = [-62, -28];
const baseModelTransform = `translate(${modelOffset.join(" ")}) scale(${modelScale})`;
const modelCenter: Point = [
    hingeX + hardwarePoint(width / 2, depth / 2)[0],
    hingeY + hardwarePoint(width / 2, depth / 2)[1] - (axisZ * bodyThickness) / 2,
];
const modelTransform = `${baseModelTransform} ${objectTransform(modelCenter)}`;
const scenePoint = (point: Point): Point => [
    point[0] * modelScale + modelOffset[0],
    point[1] * modelScale + modelOffset[1],
];
const modelPoint = (point: Point) => scenePoint(scalePoint(point, modelCenter));
// Attach the leader inside the front wall, below the seam covered by the lid.
const bodyAnchor: Point = [
    hingeX + axisX[0] * 20 + axisY[0] * depth,
    hingeY + axisX[1] * 20 + axisY[1] * depth - (axisZ * bodyThickness) / 2,
];
const sceneAnchor = modelPoint(bodyAnchor);
// Halve the leg below the body while retaining its projected depth angle.
const claudeBendX = sceneAnchor[0] + (144 - sceneAnchor[0]) * 0.5;
const claudeBendY = sceneAnchor[1] + ((claudeBendX - sceneAnchor[0]) * axisY[1]) / axisY[0];
const claudeLabelOriginX = 86;
const claudeLabelOriginY = 208;
const claudeConnectionStartY = claudeLabelOriginY + processLabelVisualBottom + processConnectionGap;
const claudeConnection = `M ${claudeBendX} ${claudeConnectionStartY} V ${claudeBendY} L ${sceneAnchor.join(" ")}`;
const claudeLabelRight = (claudeBendX - claudeLabelOriginX) / processLabelScale;
const claudeIndicatorX = claudeLabelRight - 72 - 17;
const codexAnchor = scalePoint([231, 371], scenePoint(modelCenter));
const codexLabelOriginX = 30;
const codexConnectionStartX = 126;
const codexConnectionBendX = 177;
const codexConnectionY =
    codexAnchor[1] + ((codexConnectionBendX - codexAnchor[0]) * axisX[1]) / axisX[0];
const codexLabelY = codexConnectionY - 17;
const codexLabelRight =
    (codexConnectionStartX - processConnectionGap - codexLabelOriginX) / processLabelScale;
const codexIndicatorShift = codexLabelRight - 33 - processTextX;
const codexConnection = `M ${codexConnectionStartX} ${codexConnectionY} H ${codexConnectionBendX} L ${codexAnchor.join(" ")}`;

// One camera and one physical scale for the deck, devices, and network routes.
// Device dimensions retain their portrait/landscape proportions before projection.
const previewDevices = {
    phone: { x: 40, y: 348, width: 72, height: 168, thickness: 6 },
    tablet: { x: 190, y: 340, width: 280, height: 240, thickness: 8 },
};
function deviceDepth(thickness: number) {
    // Express world-Z depth in the shared XY plane; it projects vertically.
    const determinant = axisX[0] * axisY[1] - axisY[0] * axisX[1];
    const vertical = -axisZ * thickness;
    return { dx: (-axisY[0] * vertical) / determinant, dy: (axisX[0] * vertical) / determinant };
}
const groundTransform = `${baseModelTransform} matrix(${axisX[0]} ${axisX[1]} ${axisY[0]} ${axisY[1]} ${hingeX} ${hingeY - axisZ * bodyThickness})`;
const devicePortY = 28;
const portDepth = deviceDepth(3);
const bodyDepth = deviceDepth(bodyThickness);
const deviceSource = scalePoint(
    [150 - portDepth.dx, 200 - portDepth.dy],
    [width / 2 - bodyDepth.dx / 2, depth / 2 - bodyDepth.dy / 2],
);
const deviceConnections = Object.entries(previewDevices).map(([kind, device]) => {
    const wall = deviceDepth(device.thickness);
    const port = scalePoint(
        [device.width + wall.dx - portDepth.dx, devicePortY + wall.dy - portDepth.dy],
        [device.width / 2 + wall.dx / 2, device.height / 2 + wall.dy / 2],
    );
    const portX = device.x - wall.dx + port[0];
    const portY = device.y - wall.dy + port[1];
    const approachX = portX + 24;
    const approachY = portY;
    // Project the signal route before drawing its dashes. A transformed dash
    // would otherwise stretch and change speed every time the route turns.
    const points: Point[] = [
        deviceSource,
        [deviceSource[0], 300 - portDepth.dy],
        [approachX, 300 - portDepth.dy],
        [approachX, approachY],
        [portX, approachY],
    ];
    return {
        kind,
        // Both ports sit three units above the ground. Keep the whole route
        // at that height so each turn follows the camera axes without a kink.
        path: `M ${points[0].join(" ")} V ${points[1][1]} H ${points[2][0]} V ${points[3][1]} H ${points[4][0]}`,
        signalPath: points
            .map(([x, y], index) => {
                const [px, py] = hardwarePoint(x, y);
                return `${index === 0 ? "M" : "L"} ${(px + hingeX) * modelScale + modelOffset[0]} ${(py + hingeY - axisZ * bodyThickness) * modelScale + modelOffset[1]}`;
            })
            .join(" "),
    };
});

export function deviceWall(width: number, height: number, radius: number, thickness: number) {
    const { dx, dy } = deviceDepth(thickness);
    // The silhouette ends at tangencies to the extrusion vector, not at the
    // corner endpoints. These circular arcs exactly match the SVG rect's rx.
    const angle = Math.atan2(-dx, dy);
    const start = [width - radius + radius * Math.cos(angle), radius + radius * Math.sin(angle)];
    const end = [radius - radius * Math.cos(angle), height - radius - radius * Math.sin(angle)];
    const arc = `A ${radius} ${radius} 0 0`;
    const front = `M ${start.join(" ")} ${arc} 1 ${width} ${radius}
        V ${height - radius} ${arc} 1 ${width - radius} ${height}
        H ${radius} ${arc} 1 ${end.join(" ")}`;
    const back = `L ${end[0] + dx} ${end[1] + dy}
        ${arc} 0 ${radius + dx} ${height + dy} H ${width - radius + dx}
        ${arc} 0 ${width + dx} ${height - radius + dy} V ${radius + dy}
        ${arc} 0 ${start[0] + dx} ${start[1] + dy} L ${start.join(" ")}`;
    return {
        dx,
        dy,
        fill: svgPath(`${front} ${back} Z`),
        outline: svgPath(`M ${end.join(" ")} ${back}`),
    };
}
const bodyWall = deviceWall(width, depth, laptopRadius, bodyThickness);
const queuePort: Point = [
    hingeX + axisX[0] * width + axisY[0] * 100,
    hingeY + axisX[1] * width + axisY[1] * 100 - (axisZ * bodyThickness) / 2,
];
const queueAnchor = modelPoint(queuePort);
const queueLabel = scenePoint(queuePort).map(
    (value, index) => value + axisX[index] * 32 * modelScale,
);
const queueConnection = `M ${queueAnchor.join(" ")} L ${queueLabel.join(" ")}`;
const schedulerAnchor = modelPoint([
    hingeX + axisX[0] * width + axisY[0] * 24,
    hingeY + axisX[1] * width + axisY[1] * 24 - (axisZ * bodyThickness) / 2,
]);
const schedulerLabelOriginX = 550;
const schedulerLabelOriginY = 86;
const schedulerConnectionX = schedulerLabelOriginX + processTextX * processLabelScale;
const schedulerConnectionStartY =
    schedulerLabelOriginY + processLabelVisualBottom + processConnectionGap;
const schedulerBendY =
    schedulerAnchor[1] + ((schedulerConnectionX - schedulerAnchor[0]) * axisX[1]) / axisX[0];
const schedulerConnection = `M ${schedulerConnectionX} ${schedulerConnectionStartY} V ${schedulerBendY} L ${schedulerAnchor.join(" ")}`;
const handoffAnchor = [
    hingeX + axisX[0] * width + axisY[0] * 170,
    hingeY + axisX[1] * width + axisY[1] * 170 - (axisZ * bodyThickness) / 2,
];
const controlAnchor = [
    hingeX + axisX[0] * width + axisY[0] * 100,
    hingeY + axisX[1] * width + axisY[1] * 100 - (axisZ * bodyThickness) / 2,
];
export const controlLaptopPort = [controlAnchor[0] * 0.58 - 45, controlAnchor[1] * 0.58 + 250];
// Midpoint of the open display's top edge, in the ControlLaptop coordinate space.
export const controlLaptopTopPort = [
    (hingeX + (axisX[0] * width) / 2) * 0.58 - 45,
    (hingeY - 2 + depth * axisZ + (axisX[1] * width) / 2) * 0.58 + 250,
];
export const controlLaptopCenter: Point = [modelCenter[0] * 0.58 - 45, modelCenter[1] * 0.58 + 250];

// The premise reuses the same rigid hardware, without the local-work lifecycle.
export function ControlLaptop({
    closed = false,
    lidDepth = lidThickness,
}: {
    closed?: boolean;
    lidDepth?: number;
}) {
    const pose =
        lidDepth === lidThickness
            ? closed
                ? closedLid
                : initialLid
            : lidGeometry(closed ? 0 : openAngle, lidDepth);
    return (
        <g data-control-laptop transform="translate(-45 250) scale(0.58)">
            <g transform={deckTransform}>
                <path className="orbit-laptop__wall" d={bodyWall.fill} />
                <path className="orbit-laptop__edge" d={bodyWall.outline} />
                <rect
                    width={width}
                    height={depth}
                    rx={laptopRadius}
                    className="orbit-laptop__deck"
                />
                <rect
                    x="26"
                    y="24"
                    width="248"
                    height="78"
                    rx="3"
                    className="orbit-laptop__trackpad"
                />
                <rect
                    x="101"
                    y="125"
                    width="98"
                    height="52"
                    rx="3"
                    className="orbit-laptop__trackpad"
                />
            </g>
            <path data-control-edge d={pose.edge} className="orbit-laptop__lid-edge" />
            <rect
                data-control-back
                transform={pose.back}
                width={width}
                height={depth}
                rx={laptopRadius}
                visibility={pose.frontFacing ? "hidden" : "visible"}
                className="orbit-laptop__lid"
            />
            <g
                data-control-face
                transform={pose.front}
                visibility={pose.frontFacing ? "visible" : "hidden"}
            >
                <rect
                    width={width}
                    height={depth}
                    rx={laptopRadius}
                    className="orbit-laptop__lid"
                />
                <text x="20" y="36" className="orbit-handoff__terminal">
                    you / control
                </text>
                <text x="20" y="72" className="orbit-handoff__terminal">
                    ❯ orbit process:list
                </text>
                <text x="20" y="105" className="orbit-handoff__terminal">
                    dev-01 · 4 running
                </text>
            </g>
            <circle
                data-control-port
                cx={controlAnchor[0]}
                cy={controlAnchor[1]}
                r="1.6"
                className="orbit-laptop__body-anchor"
            />
        </g>
    );
}

function PreviewDevice({ kind, phase }: { kind: "phone" | "tablet"; phase: Phase }) {
    const phone = kind === "phone";
    const online = phase === "running";
    const reconnecting = phase === "opening";
    const device = previewDevices[kind];
    // Preserve the screen layout when shrinking the phone's physical dimensions.
    const contentScale = phone ? 6 / 7 : 1.25;
    const deviceWidth = device.width / contentScale;
    const deviceHeight = device.height / contentScale;
    const center = deviceWidth / 2;
    const cardWidth = (deviceWidth - 36) / 2;
    const radius = phone ? 9 : 8;
    const wall = deviceWall(device.width, device.height, radius, device.thickness);

    return (
        <g
            data-preview-device={kind}
            data-connection={online ? "online" : reconnecting ? "reconnecting" : "offline"}
            className="orbit-laptop__device"
            transform={`translate(${device.x - wall.dx} ${device.y - wall.dy}) ${objectTransform([device.width / 2 + wall.dx / 2, device.height / 2 + wall.dy / 2])}`}
        >
            <path data-device-wall d={wall.fill} className="orbit-laptop__device-wall" />
            <path data-device-edge d={wall.outline} className="orbit-laptop__device-edge" />
            <rect
                data-device-shell
                width={device.width}
                height={device.height}
                rx={radius}
                className="orbit-laptop__device-shell"
            />
            <circle
                data-device-port
                cx={device.width + wall.dx - portDepth.dx}
                cy={devicePortY + wall.dy - portDepth.dy}
                r="1.3"
                className="orbit-laptop__device-port"
            />
            <g transform={`scale(${contentScale})`}>
                <rect
                    x="6"
                    y="10"
                    width={deviceWidth - 12}
                    height={deviceHeight - 20}
                    rx="3"
                    className="orbit-laptop__device-screen"
                />
                <rect
                    x={center - 10}
                    y="4"
                    width="20"
                    height="2"
                    rx="1"
                    className="orbit-laptop__device-speaker"
                />
                <g className="orbit-laptop__browser-chrome">
                    <path d={`M 6 29 H ${deviceWidth - 6}`} />
                    <circle cx="14" cy="20" r="1.5" />
                    <text x="21" y="23">
                        project.test
                    </text>
                </g>
                {online ? (
                    <g data-device-page="loaded" className="orbit-laptop__device-page">
                        <text x="14" y="48" className="orbit-laptop__device-brand">
                            Studio
                        </text>
                        <path d={`M 14 56 H ${deviceWidth - 14}`} className="orbit-laptop__rule" />
                        <rect
                            x="14"
                            y="65"
                            width={deviceWidth - 28}
                            height={phone ? 29 : 32}
                            rx="2"
                            className="orbit-laptop__device-hero"
                        />
                        <path
                            d={`M 21 75 h ${phone ? 37 : 78} M 21 82 h ${phone ? 24 : 51}`}
                            className="orbit-laptop__device-copy"
                        />
                        <rect
                            x="14"
                            y={phone ? 104 : 107}
                            width={cardWidth}
                            height="20"
                            rx="2"
                            className="orbit-laptop__device-card"
                        />
                        <rect
                            x={22 + cardWidth}
                            y={phone ? 104 : 107}
                            width={cardWidth}
                            height="20"
                            rx="2"
                            className="orbit-laptop__device-card"
                        />
                        <circle
                            cx="16"
                            cy={deviceHeight - 18}
                            r="2"
                            className="orbit-laptop__online-dot"
                        />
                        <text x="23" y={deviceHeight - 15} className="orbit-laptop__device-online">
                            Live preview
                        </text>
                    </g>
                ) : (
                    <g data-device-page="error" className="orbit-laptop__device-error">
                        <g
                            transform={`translate(${center} ${phone ? 65 : 62})`}
                            className="orbit-laptop__broken-link"
                        >
                            <path d="M -2 -7 H -7 V -2 M 2 7 H 7 V 2 M -8 8 L 8 -8 M -3 3 L 3 -3" />
                        </g>
                        <text
                            x={center}
                            y={phone ? 90 : 87}
                            textAnchor="middle"
                            className="orbit-laptop__device-error-title"
                        >
                            {reconnecting ? "Reconnecting…" : "Site unreachable"}
                        </text>
                        <text
                            x={center}
                            y={phone ? 105 : 102}
                            textAnchor="middle"
                            className="orbit-laptop__device-error-detail"
                        >
                            {reconnecting ? "Waiting for laptop" : "Laptop is offline"}
                        </text>
                        <text
                            x={center}
                            y={phone ? 138 : 124}
                            textAnchor="middle"
                            className="orbit-laptop__device-error-code"
                        >
                            ERR_CONNECTION_LOST
                        </text>
                    </g>
                )}
            </g>
        </g>
    );
}

export function Laptop() {
    const [phase, setPhase] = useState<Phase>("running");
    const sceneRef = useRef<SVGSVGElement>(null);
    useSceneViewport(sceneRef, "0 0 740 755", "90 80 560 640", "20 60 710 665");
    const lidRef = useRef<SVGGElement>(null);
    const faceRef = useRef<SVGGElement>(null);
    const backRef = useRef<SVGRectElement>(null);
    const edgeRef = useRef<SVGPathElement>(null);
    const angleRef = useRef(openAngle);
    const frontFacingRef = useRef(initialLid.frontFacing);
    const active = phase === "running";
    const closed = phase === "closing" || phase === "sleeping";

    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;
        return observeSceneActivity(scene, ({ active }) => {
            scene.dataset.motionActive = String(active);
        });
    }, []);

    // The reader owns the timeline. Hold the lid open after the entrance,
    // then close it over a later stretch of scroll.
    // Geometry is imperative; React only renders at a process-state boundary.
    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;
        const entrance = scene.parentElement!;
        const style = getComputedStyle(scene);
        const signalLength = parseFloat(style.getPropertyValue("--laptop-signal-length"));
        const signalSpeed = parseFloat(style.getPropertyValue("--laptop-signal-speed"));
        const signalRest = parseFloat(style.getPropertyValue("--laptop-signal-rest"));
        // All routes use scene coordinates, so this stays valid after resizing.
        // Let the whole pulse leave before the next one enters the connection.
        scene.querySelectorAll<SVGPathElement>(".orbit-laptop__signals path").forEach((path) => {
            const period = path.getTotalLength() + signalLength + signalSpeed * signalRest;
            path.style.setProperty("--laptop-signal-period", `${period}px`);
            path.style.setProperty("--laptop-signal-duration", `${period / signalSpeed}s`);
        });
        const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let frame = 0;
        let dirty = true;
        let disposed = false;
        let start = 0;
        let distance = 1;
        let revealStart = 0;
        let revealDistance = 1;
        let revealRate = 2;
        let exitStart = 0;
        let exitDistance = 1;
        let previousOpacity = -1;
        let previousReveal = -1;
        let previous = -1;
        let currentPhase: Phase = "running";
        const paint = (_time: number, scrollTop: number) => {
            frame = 0;
            if (disposed) return;
            if (dirty) {
                const bounds = storyLayoutBounds(scene);
                const revealEnd = storyEntranceEnd(bounds, scrollTop, window.innerHeight);
                start = laptopCloseStart(bounds, scrollTop, window.innerHeight);
                distance = Math.max(180, bounds.height * 0.42);
                revealStart = revealEnd - Math.max(180, window.innerHeight * 0.3) + 40;
                revealDistance = revealEnd - revealStart;
                revealRate = window.innerWidth <= 1100 ? 4 : 2;
                // Keep the illustration crisp through the lid closure, then
                // dissolve it as it leaves the viewport above the connection.
                exitStart = Math.max(
                    start + distance + window.innerHeight * 0.08,
                    bounds.bottom + scrollTop - window.innerHeight * 0.35,
                );
                exitDistance = Math.max(140, window.innerHeight * 0.3);
                scene.dataset.exitStart = String(exitStart);
                scene.dataset.exitEnd = String(exitStart + exitDistance);
                scene.dataset.revealStart = String(revealStart);
                scene.dataset.revealEnd = String(revealEnd);
                scene.dataset.scrollStart = String(start);
                scene.dataset.scrollEnd = String(start + distance);
                dirty = false;
            }
            const reveal = motion.matches
                ? 1
                : Math.max(0, Math.min(1, (scrollTop - revealStart) / revealDistance));
            if (reveal !== previousReveal) {
                scene.dataset.revealProgress = reveal.toFixed(3);
                previousReveal = reveal;
            }
            const exiting = motion.matches
                ? 0
                : Math.max(0, Math.min(1, (scrollTop - exitStart) / exitDistance));
            // Compact scenes sharpen in a quarter of the entrance interval,
            // giving the reader more time with the open laptop fully visible.
            const opacity = Math.min(1, reveal * revealRate) * (1 - exiting);
            if (opacity !== previousOpacity) {
                entrance.style.setProperty("--laptop-layer-opacity", String(opacity));
                entrance.style.setProperty(
                    "--laptop-layer-filter",
                    opacity === 1 ? "none" : `blur(calc(var(--blur-story-layer) * ${1 - opacity}))`,
                );
                previousOpacity = opacity;
            }
            const progress = motion.matches
                ? 0
                : Math.max(0, Math.min(1, (scrollTop - start) / distance));
            if (progress === previous) return;
            const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
            angleRef.current = openAngle * (1 - eased);
            const geometry = lidGeometry(angleRef.current);
            faceRef.current?.setAttribute("transform", geometry.front);
            backRef.current?.setAttribute("transform", geometry.back);
            // Visibility is inherited by the terminal's children. Only change
            // it at the face crossing, not on every animation frame.
            if (frontFacingRef.current !== geometry.frontFacing) {
                faceRef.current?.setAttribute(
                    "visibility",
                    geometry.frontFacing ? "visible" : "hidden",
                );
                backRef.current?.setAttribute(
                    "visibility",
                    geometry.frontFacing ? "hidden" : "visible",
                );
                frontFacingRef.current = geometry.frontFacing;
            }
            edgeRef.current?.setAttribute("d", geometry.edge);
            lidRef.current?.setAttribute("data-angle", String(angleRef.current));
            const next: Phase =
                progress === 0
                    ? "running"
                    : progress === 1
                      ? "sleeping"
                      : progress < previous
                        ? "opening"
                        : "closing";
            if (next !== currentPhase) {
                currentPhase = next;
                setPhase(next);
            }
            previous = progress;
        };
        const schedule = () => {
            if (!frame) frame = requestScrollFrame(paint);
        };
        const measure = () => {
            dirty = true;
            schedule();
        };
        const observer = new ResizeObserver(measure);
        observer.observe(scene);
        const stopScroll = observeScroll(schedule);
        window.addEventListener("resize", measure);
        motion.addEventListener("change", schedule);
        void document.fonts.ready.then(() => {
            if (!disposed) measure();
        });
        schedule();
        return () => {
            disposed = true;
            cancelScrollFrame(frame);
            observer.disconnect();
            stopScroll();
            window.removeEventListener("resize", measure);
            motion.removeEventListener("change", schedule);
            entrance.style.removeProperty("--laptop-layer-opacity");
            entrance.style.removeProperty("--laptop-layer-filter");
            delete scene.dataset.exitStart;
            delete scene.dataset.exitEnd;
        };
    }, []);

    const status =
        phase === "running"
            ? "active"
            : phase === "closing"
              ? "pausing"
              : phase === "opening"
                ? "resuming"
                : "suspended";

    return (
        <div data-laptop-entrance className="flex w-full flex-col items-center">
            <svg
                ref={sceneRef}
                data-laptop
                data-motion-active="false"
                data-phase={phase}
                data-run={active ? "1" : "0"}
                className="orbit-laptop-scene"
                viewBox="0 0 740 755"
                role="img"
                aria-label="A laptop runs Claude Code, Codex, a Laravel queue worker, and the Laravel scheduler. Phone and tablet browsers can reach its local website while the laptop is open. Closing the lid suspends the processes and makes the website unreachable on both devices."
            >
                <g aria-hidden="true" strokeLinejoin="round">
                    <g className="orbit-laptop__connections">
                        <path data-claude-connection d={claudeConnection} />
                        <path data-codex-connection d={codexConnection} />
                        <path data-queue-connection d={queueConnection} />
                        <path data-scheduler-connection d={schedulerConnection} />
                        <circle cx={codexAnchor[0]} cy={codexAnchor[1]} r="2" />
                        <circle data-queue-anchor cx={queueAnchor[0]} cy={queueAnchor[1]} r="2" />
                    </g>
                    <g className="orbit-laptop__signals">
                        <path d={claudeConnection} />
                        <path d={codexConnection} />
                        <path d={queueConnection} />
                        <path d={schedulerConnection} />
                    </g>
                    <g data-device-plane transform={groundTransform}>
                        <g
                            className="orbit-laptop__device-links"
                            data-connected={active ? "true" : "false"}
                        >
                            {deviceConnections.map(({ kind, path }) => (
                                <path key={kind} data-device-link={kind} d={path} />
                            ))}
                        </g>
                        <PreviewDevice kind="phone" phase={phase} />
                        <PreviewDevice kind="tablet" phase={phase} />
                    </g>
                    <g className="orbit-laptop__signals">
                        {deviceConnections.map(({ kind, signalPath }) => (
                            <path key={kind} data-device-signal={kind} d={signalPath} />
                        ))}
                    </g>
                    <g data-laptop-model transform={modelTransform}>
                        <g transform={deckTransform}>
                            <path data-body-wall className="orbit-laptop__wall" d={bodyWall.fill} />
                            <path
                                data-body-edge
                                className="orbit-laptop__edge"
                                d={bodyWall.outline}
                            />
                            <rect
                                data-deck
                                width={width}
                                height={depth}
                                rx={laptopRadius}
                                className="orbit-laptop__deck"
                            />
                            <g className="orbit-laptop__keyboard">
                                <rect x="26" y="24" width="248" height="78" rx="3" />
                                {[1, 2, 3].map((row) => (
                                    <path key={row} d={`M 26 ${24 + row * 19.5} h 248`} />
                                ))}
                                {Array.from({ length: 11 }, (_, column) => (
                                    <path
                                        key={column}
                                        d={`M ${26 + (column + 1) * (248 / 12)} 24 v 78`}
                                    />
                                ))}
                            </g>
                            <rect
                                x="101"
                                y="125"
                                width="98"
                                height="52"
                                rx="3"
                                className="orbit-laptop__trackpad"
                            />
                        </g>
                        <g
                            ref={lidRef}
                            data-lid={closed ? "closed" : "open"}
                            data-angle={openAngle}
                        >
                            <path
                                ref={edgeRef}
                                data-lid-edge
                                d={initialLid.edge}
                                className="orbit-laptop__lid-edge"
                            />
                            <rect
                                ref={backRef}
                                data-lid-back
                                transform={initialLid.back}
                                width={width}
                                height={depth}
                                rx={laptopRadius}
                                visibility={initialLid.frontFacing ? "hidden" : "visible"}
                                className="orbit-laptop__lid"
                            />
                            <g ref={faceRef} data-lid-face transform={initialLid.front}>
                                <rect
                                    data-lid-surface
                                    width={width}
                                    height={depth}
                                    rx={laptopRadius}
                                    className="orbit-laptop__lid"
                                />
                                <g
                                    data-sess
                                    data-run={active ? "1" : "0"}
                                    className="orbit-laptop__session"
                                    key={`session-${phase}`}
                                >
                                    <text x="17" y="23" className="orbit-laptop__terminal-title">
                                        agent / ~/orbit
                                    </text>
                                    <path d="M 17 33 H 283" className="orbit-laptop__rule" />
                                    <text x="17" y="55" className="orbit-laptop__prompt">
                                        ❯ Tidy up Node.php
                                    </text>
                                    <text
                                        x="17"
                                        y="79"
                                        className="orbit-session-line orbit-session-line--1"
                                    >
                                        · read src/Orbit/Node.php
                                    </text>
                                    <text
                                        x="17"
                                        y="99"
                                        className="orbit-session-line orbit-session-line--2"
                                    >
                                        · edit Node.php, NodeTest.php
                                    </text>
                                    <text
                                        x="17"
                                        y="119"
                                        className="orbit-session-line orbit-session-line--3"
                                    >
                                        {" "}
                                        +34 −12 across 2 files
                                    </text>
                                    <text
                                        x="17"
                                        y="148"
                                        className="orbit-session-line orbit-session-line--4"
                                    >
                                        ❯ vendor/bin/pest
                                        <tspan data-caret className="orbit-laptop__caret">
                                            {" "}
                                            ▍
                                        </tspan>
                                    </text>
                                    <path d="M 17 178 H 237" className="orbit-laptop__rule" />
                                    <path
                                        data-bar
                                        d="M 17 178 H 237"
                                        pathLength="100"
                                        className="orbit-laptop__progress"
                                    />
                                    <text x="251" y="181" className="orbit-laptop__terminal-title">
                                        tests
                                    </text>
                                </g>
                            </g>
                        </g>
                        <circle
                            data-body-anchor
                            cx={bodyAnchor[0]}
                            cy={bodyAnchor[1]}
                            r="1.6"
                            className="orbit-laptop__body-anchor"
                        />
                        <circle
                            data-handoff-source
                            cx={handoffAnchor[0]}
                            cy={handoffAnchor[1]}
                            r="1.6"
                            className="orbit-laptop__body-anchor"
                        />
                    </g>
                    <g
                        data-process="scheduler"
                        data-status={status}
                        className="orbit-laptop__process"
                        transform={`translate(${schedulerLabelOriginX} ${schedulerLabelOriginY}) scale(${processLabelScale})`}
                    >
                        <g className="orbit-laptop__scheduler-indicator">
                            <circle cx="8" cy="0" r="7" />
                            <path d="M 8 -4 V 0 L 11 2" />
                        </g>
                        <text x={processTextX} y="4" className="orbit-laptop__process-name">
                            Laravel scheduler
                        </text>
                        <text x={processTextX} y="22" className="orbit-laptop__process-detail">
                            cron · {active ? "ticking" : status}
                        </text>
                    </g>
                    <circle
                        data-scheduler-anchor
                        cx={schedulerAnchor[0]}
                        cy={schedulerAnchor[1]}
                        r="1.6"
                        className="orbit-laptop__body-anchor"
                    />
                    <g
                        data-process="claude"
                        data-status={status}
                        className="orbit-laptop__process"
                        transform={`translate(${claudeLabelOriginX} ${claudeLabelOriginY}) scale(${processLabelScale})`}
                    >
                        <g transform={`translate(${claudeIndicatorX} 0)`}>
                            <path
                                className="orbit-laptop__claude-indicator"
                                d="M 0 -7 V 7 M -7 0 H 7 M -5 -5 L 5 5 M -5 5 L 5 -5 M -3 -6 L 3 6 M -6 3 L 6 -3"
                            />
                        </g>
                        <text
                            x={claudeLabelRight}
                            y="4"
                            textAnchor="end"
                            className="orbit-laptop__process-name"
                        >
                            Claude Code
                        </text>
                        <text
                            x={claudeLabelRight}
                            y="22"
                            textAnchor="end"
                            className="orbit-laptop__process-detail"
                        >
                            CLI · {active ? "editing" : status}
                        </text>
                    </g>
                    <g
                        data-process="codex"
                        data-status={status}
                        className="orbit-laptop__process"
                        transform={`translate(${codexLabelOriginX} ${codexLabelY}) scale(${processLabelScale})`}
                    >
                        <g
                            className="orbit-laptop__codex-indicator"
                            transform={`translate(${codexIndicatorShift} 0)`}
                        >
                            <rect x="1" y="-3" width="3" height="6" />
                            <rect x="6" y="-3" width="3" height="6" />
                            <rect x="11" y="-3" width="3" height="6" />
                        </g>
                        <text
                            x={codexLabelRight}
                            y="4"
                            textAnchor="end"
                            className="orbit-laptop__process-name"
                        >
                            Codex
                        </text>
                        <text
                            x={codexLabelRight}
                            y="22"
                            textAnchor="end"
                            className="orbit-laptop__process-detail"
                        >
                            CLI · {active ? "reviewing" : status}
                        </text>
                    </g>
                    <g
                        data-process="queue"
                        data-status={status}
                        className="orbit-laptop__process"
                        transform={`translate(${queueLabel[0] + queueLabelOffset} ${queueLabel[1]}) scale(${processLabelScale})`}
                    >
                        <g className="orbit-laptop__queue-indicator">
                            <rect x="1" y="-7" width="12" height="3" />
                            <rect x="1" y="-1" width="12" height="3" />
                            <rect x="1" y="5" width="12" height="3" />
                        </g>
                        <text x="25" y="4" className="orbit-laptop__process-name">
                            Laravel queue
                        </text>
                        <text x="25" y="22" className="orbit-laptop__process-detail">
                            worker · {active ? "processing" : status}
                        </text>
                    </g>
                </g>
            </svg>
        </div>
    );
}
