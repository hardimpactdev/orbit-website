import { animateScene } from "./animation";
import { useEffect, useId, useRef } from "react";
import { ConstellationSignalGradient, constellationSignal, globe } from "./hero-constellation";
import { hardwarePlane } from "./laptop";
import { svgNumber } from "./svg-precision";

const center = { x: 360, y: 175 };
const orbit = { rx: 303.75, ry: 135 };
const nodes = Array.from({ length: 8 }, () => 22);
const agents = ["hermesagent", "openclaw", "grok"];
// Equal distances around the ellipse keep nodes from bunching at its narrow ends.
const orbitSamples = Array.from({ length: 1025 }, (_, index) => {
    const angle = (index / 1024) * Math.PI * 2;
    return { x: orbit.rx * Math.cos(angle), y: orbit.ry * Math.sin(angle), distance: 0 };
});
orbitSamples.forEach((sample, index) => {
    if (!index) return;
    const previous = orbitSamples[index - 1];
    sample.distance = previous.distance + Math.hypot(sample.x - previous.x, sample.y - previous.y);
});
const orbitLength = orbitSamples[1024].distance;
const position = (index: number, time = 0) => {
    const distance = ((index / nodes.length + 0.96 + time / 114) % 1) * orbitLength;
    let low = 0;
    let high = orbitSamples.length - 1;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (orbitSamples[middle].distance < distance) low = middle;
        else high = middle;
    }
    const from = orbitSamples[low];
    const to = orbitSamples[high];
    const progress = (distance - from.distance) / (to.distance - from.distance);
    return {
        // Node and browsers can differ in the last digits of Math.hypot.
        // Serialize SVG coordinates at a stable precision for hydration.
        x: svgNumber(center.x + from.x + (to.x - from.x) * progress),
        y: svgNumber(center.y + from.y + (to.y - from.y) * progress),
    };
};
const connection = (to: { x: number; y: number }) => `M ${center.x} ${center.y} L ${to.x} ${to.y}`;

export function AgentNetwork() {
    const ref = useRef<SVGSVGElement>(null);
    const gradient = useId();
    useEffect(() => {
        const scene = ref.current;
        if (!scene) return;
        const planets = [...scene.querySelectorAll<SVGGElement>("[data-agent-planet]")];
        const latitudes = planets.map((planet) => planet.querySelector("path")!);
        const links = [...scene.querySelectorAll<SVGPathElement>("[data-agent-link]")];
        const signals = [...scene.querySelectorAll<SVGGElement>("[data-agent-signal]")];
        const signalLayer = scene.querySelector<SVGGElement>("[data-agent-signals]")!;
        let lastGlobe = -Infinity;
        // Geometry and globe detail have separate cadences, with no layout reads.
        return animateScene(
            scene,
            (elapsed) => {
                const updateGlobes = elapsed - lastGlobe >= 1 / 15;
                if (updateGlobes) lastGlobe = elapsed;
                nodes.forEach((radius, index) => {
                    const to = position(index, elapsed);
                    planets[index].setAttribute("transform", `translate(${to.x} ${to.y})`);
                    if (updateGlobes)
                        latitudes[index].setAttribute("d", globe(radius, index * 0.7, elapsed));
                    links[index].setAttribute("d", connection(to));
                    const inbound = index % 2 === 0;
                    const signal = constellationSignal(
                        inbound ? to : center,
                        inbound ? center : to,
                        elapsed,
                        index,
                        false,
                    );
                    signals[index].setAttribute("transform", signal.transform);
                    signals[index].setAttribute("opacity", String(signal.opacity));
                });
            },
            {
                fps: () => 30,
                onActivity: ({ active, visible }) => {
                    scene.dataset.agentActive = String(visible);
                    signalLayer.setAttribute("visibility", active ? "visible" : "hidden");
                },
            },
        );
    }, []);

    return (
        <div className="orbit-capability__drawing orbit-capability__drawing--agents">
            <svg
                ref={ref}
                data-agent-network
                data-agent-active="false"
                viewBox="0 0 720 350"
                className="orbit-capability__agent-scene"
                role="img"
                aria-label="Hermes, OpenClaw or Grok on a central coin, exchanging signals with eight orbiting planet nodes."
            >
                <defs>
                    <ConstellationSignalGradient id={gradient} />
                </defs>
                <ellipse
                    cx={center.x}
                    cy={center.y}
                    rx={orbit.rx}
                    ry={orbit.ry}
                    className="orbit-capability__agent-orbit"
                    vectorEffect="non-scaling-stroke"
                />
                <g className="orbit-capability__agent-links">
                    {nodes.map((_, index) => (
                        <path
                            key={index}
                            data-agent-link
                            d={connection(position(index))}
                            vectorEffect="non-scaling-stroke"
                        />
                    ))}
                </g>
                <g data-agent-signals visibility="hidden">
                    {nodes.map((_, index) => (
                        <g
                            key={index}
                            data-agent-signal
                            data-direction={index % 2 === 0 ? "inbound" : "outbound"}
                            opacity="0"
                        >
                            <path
                                d="M -26 0 H 0"
                                stroke={`url(#${gradient})`}
                                strokeWidth="1.5"
                                strokeLinecap="round"
                            />
                        </g>
                    ))}
                </g>
                {nodes.map((r, index) => {
                    const p = position(index);
                    return (
                        <g key={index} data-agent-planet transform={`translate(${p.x} ${p.y})`}>
                            <circle
                                r={r}
                                className="orbit-capability__agent-core"
                                strokeWidth="1"
                                vectorEffect="non-scaling-stroke"
                            />
                            <path
                                d={globe(r, index * 0.7, 0)}
                                strokeWidth="1"
                                vectorEffect="non-scaling-stroke"
                            />
                        </g>
                    );
                })}
                <g data-agent-platform>
                    <ellipse
                        cx={center.x}
                        cy={center.y + 3.5}
                        rx="38"
                        ry="19"
                        className="orbit-capability__coin-edge"
                    />
                    <g transform={hardwarePlane(center.x, center.y)}>
                        <circle r="38" className="orbit-capability__coin-face" />
                        <circle r="33.5" className="orbit-capability__coin-rim" />
                        {agents.map((agent) => (
                            <image
                                key={agent}
                                data-agent-icon={agent}
                                className="orbit-capability__agent-icon"
                                href={`/assets/orbit/agents/${agent}.svg`}
                                x="-26"
                                y="-26"
                                width="52"
                                height="52"
                            />
                        ))}
                    </g>
                </g>
            </svg>
        </div>
    );
}
