import { useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { AgentNetwork } from "../../resources/js/components/orbit/agent-network";

function Scene() {
    useEffect(() => {
        document.documentElement.dataset.hydrated = "true";
    }, []);

    return <AgentNetwork />;
}

export function render() {
    return renderToString(<Scene />);
}

if (typeof document !== "undefined") {
    hydrateRoot(document.getElementById("app")!, <Scene />);
}
