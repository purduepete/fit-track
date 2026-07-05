import { useEffect } from "react";
import { MapContainer, Polyline, TileLayer, CircleMarker, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { RoutePoint } from "../lib/api";

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 0) {
      map.fitBounds(points as any, { padding: [24, 24] });
    }
  }, [map, points]);
  return null;
}

/** Renders a GPS route as a polyline with start/end markers (OpenStreetMap). */
export function RouteMap({ route }: { route: RoutePoint[] }) {
  const points: [number, number][] = route.map((p) => [p.lat, p.lon]);
  if (points.length === 0) return null;

  return (
    <div className="map">
      <MapContainer style={{ height: "100%", width: "100%" }} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Polyline positions={points} pathOptions={{ color: "#7c3aed", weight: 4 }} />
        <CircleMarker center={points[0]} radius={7} pathOptions={{ color: "#16a34a", fillOpacity: 1 }} />
        <CircleMarker
          center={points[points.length - 1]}
          radius={7}
          pathOptions={{ color: "#e5484d", fillOpacity: 1 }}
        />
        <FitBounds points={points} />
      </MapContainer>
    </div>
  );
}
