import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Polyline, TileLayer, CircleMarker, useMap } from 'react-leaflet';
import type { Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { RoutePoint } from '../lib/api';
import { CrosshairIcon } from './Icons';

function FitBounds({ points }: { points: [number, number][] }) {
    const map = useMap();
    useEffect(() => {
        if (points.length > 0) {
            map.fitBounds(points, { padding: [24, 24] });
        }
    }, [map, points]);
    return null;
}

/** Renders a GPS route as a polyline with start/end markers (OpenStreetMap). */
export function RouteMap({ route }: { route: RoutePoint[] }) {
    // Memoize the derived [lat, lon] array so its identity only changes when the
    // route does; otherwise parent re-renders would re-trigger FitBounds.
    const points = useMemo<[number, number][]>(() => route.map((p) => [p.lat, p.lon]), [route]);
    const [map, setMap] = useState<LeafletMap | null>(null);
    if (points.length === 0) return null;

    return (
        <div className="map data-enter">
            <MapContainer ref={setMap} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Polyline positions={points} pathOptions={{ color: '#7c3aed', weight: 4 }} />
                <CircleMarker center={points[0]} radius={7} pathOptions={{ color: '#16a34a', fillOpacity: 1 }} />
                <CircleMarker
                    center={points[points.length - 1]}
                    radius={7}
                    pathOptions={{ color: '#e5484d', fillOpacity: 1 }}
                />
                <FitBounds points={points} />
            </MapContainer>
            <button
                type="button"
                className="map-recenter"
                data-tip="Re-center route"
                aria-label="Re-center route"
                onClick={() => map?.fitBounds(points, { padding: [24, 24] })}
            >
                <CrosshairIcon size={16} />
            </button>
        </div>
    );
}
