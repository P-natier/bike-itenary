require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_MAPS_API_BASE = 'https://maps.googleapis.com/maps/api';

// --- Helper functions (calculateDestinationPoint and new getBearing) ---
function calculateDestinationPoint(lat, lng, bearing, distance) {
    const R = 6371;
    const d = distance;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lng * Math.PI) / 180;
    const brng = (bearing * Math.PI) / 180;
    let lat2 = Math.asin(Math.sin(lat1) * Math.cos(d / R) + Math.cos(lat1) * Math.sin(d / R) * Math.cos(brng));
    let lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d / R) * Math.cos(lat1), Math.cos(d / R) - Math.sin(lat1) * Math.sin(lat2));
    lat2 = (lat2 * 180) / Math.PI;
    lon2 = (lon2 * 180) / Math.PI;
    return { lat: lat2, lng: lon2 };
}

function getBearing(startPoint, endPoint) {
    const lat1 = (startPoint.lat * Math.PI) / 180;
    const lon1 = (startPoint.lng * Math.PI) / 180;
    const lat2 = (endPoint.lat * Math.PI) / 180;
    const lon2 = (endPoint.lng * Math.PI) / 180;
    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
    const brng = Math.atan2(y, x);
    return ((brng * 180) / Math.PI + 360) % 360;
}

// --- Main API Endpoint ---
app.post('/api/generate-loop', async (req, res) => {
    const { startLocation, targetDistance, mandatoryWaypoint } = req.body;

    if (!startLocation || !targetDistance) {
        return res.status(400).json({ error: 'Missing startLocation or targetDistance' });
    }

    try {
        let route;
        // DECISION: Check if a mandatory waypoint was provided
        if (mandatoryWaypoint) {
            console.log(`Generating loop with mandatory waypoint: "${mandatoryWaypoint}"`);
            route = await generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypoint);
        } else {
            console.log("Generating a random loop.");
            route = await generateRandomLoop(startLocation, targetDistance);
        }

        if (!route) {
            throw new Error("Could not generate a valid route.");
        }

        res.json({
            polyline: route.overview_polyline.points,
            totalDistance: route.legs.reduce((total, leg) => total + leg.distance.value, 0),
            totalDuration: route.legs.reduce((total, leg) => total + leg.duration.value, 0),
        });

    } catch (error) {
        console.error("Error in main handler:", error.message);
        res.status(500).json({ error: 'Failed to generate loop itinerary.', details: error.message });
    }
});


// --- NEW: Function to handle loops with a mandatory stop ---
async function generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypointAddress) {
    // 1. Geocode the mandatory waypoint address to get its coordinates
    const geoResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/geocode/json`, {
        params: { address: mandatoryWaypointAddress, key: API_KEY }
    });
    if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
        throw new Error(`Could not find location for: "${mandatoryWaypointAddress}"`);
    }
    const mandatoryPoint = geoResponse.data.results[0].geometry.location; // {lat, lng}

    // 2. Calculate the direct out-and-back route distance
    const directRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, {
        params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: `${mandatoryPoint.lat},${mandatoryPoint.lng}`, mode: 'bicycling', key: API_KEY }
    });
    const directRoute = directRouteResponse.data.routes[0];
    const directDistance = directRoute.legs.reduce((sum, leg) => sum + leg.distance.value, 0);

    // 3. Calculate the distance we need to add
    const targetDistanceMeters = targetDistance * 1000;
    const distanceDeficit = targetDistanceMeters - directDistance;

    // If the direct route is already long enough, just return it
    if (distanceDeficit <= 0) {
        console.log("Direct route is long enough, returning as is.");
        return directRoute;
    }
    
    console.log(`Direct route is ${directDistance / 1000}km. Need to add ${distanceDeficit / 1000}km.`);

    // 4. Create detours to add the missing distance
    // We'll add half the deficit to the outbound leg and half to the return leg
    const detourLegDistance = (distanceDeficit / 2) / 2; // Split deficit in 2 legs, and use a midpoint for the detour

    // Find a detour point for the outbound leg (Start -> Mandatory)
    const bearingOut = getBearing(startLocation, mandatoryPoint);
    const detourBearingOut = (bearingOut + 90 * (Math.random() > 0.5 ? 1 : -1) + 360) % 360; // 90 degrees left or right
    const midpointOut = { lat: (startLocation.lat + mandatoryPoint.lat) / 2, lng: (startLocation.lng + mandatoryPoint.lng) / 2 };
    const theoreticalDetour1 = calculateDestinationPoint(midpointOut.lat, midpointOut.lng, detourBearingOut, detourLegDistance / 1000);
    
    // Find a detour point for the return leg (Mandatory -> Start)
    const bearingIn = getBearing(mandatoryPoint, startLocation);
    const detourBearingIn = (bearingIn + 90 * (Math.random() > 0.5 ? 1 : -1) + 360) % 360;
    const midpointIn = { lat: (mandatoryPoint.lat + startLocation.lat) / 2, lng: (mandatoryPoint.lng + startLocation.lng) / 2 };
    const theoreticalDetour2 = calculateDestinationPoint(midpointIn.lat, midpointIn.lng, detourBearingIn, detourLegDistance / 1000);
    
    // 5. Build the final route with all waypoints in order
    const waypointsString = [
        `${theoreticalDetour1.lat},${theoreticalDetour1.lng}`,
        `${mandatoryPoint.lat},${mandatoryPoint.lng}`,
        `${theoreticalDetour2.lat},${theoreticalDetour2.lng}`
    ].join('|');
    
    const finalRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, {
        params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: waypointsString, mode: 'bicycling', key: API_KEY }
    });

    return finalRouteResponse.data.routes[0];
}


// --- This is our previous robust function, now renamed ---
async function generateRandomLoop(startLocation, targetDistance) {
    const MAIN_ATTEMPTS = 10;
    const REFINE_ITERATIONS = 3;
    const ADJUSTMENT_FACTOR = 0.75;
    const targetDistanceMeters = targetDistance * 1000;
    let bestRoute = null;
    let minError = Infinity;

    for (let attempt = 0; attempt < MAIN_ATTEMPTS; attempt++) {
        const randomStartAngle = Math.random() * 360;
        const bearings = [(randomStartAngle), (randomStartAngle + 90) % 360, (randomStartAngle + 180) % 360];
        let legDistance = targetDistance / 4;

        for (let i = 0; i < REFINE_ITERATIONS; i++) {
            const waypoints = [];
            let currentPoint = startLocation;
            let canCreateWaypoints = true;
            for (const bearing of bearings) {
                const theoreticalPoint = calculateDestinationPoint(currentPoint.lat, currentPoint.lng, bearing, legDistance);
                try {
                    const snapResponse = await axios.get(`https://roads.googleapis.com/v1/snapToRoads`, { params: { path: `${theoreticalPoint.lat},${theoreticalPoint.lng}`, interpolate: false, key: API_KEY } });
                    if (snapResponse.data.snappedPoints && snapResponse.data.snappedPoints.length > 0) {
                        const snappedPoint = snapResponse.data.snappedPoints[0].location;
                        waypoints.push({ lat: snappedPoint.latitude, lng: snappedPoint.longitude });
                        currentPoint = waypoints[waypoints.length - 1];
                    } else { throw new Error(`No snapped points`); }
                } catch (snapError) { canCreateWaypoints = false; break; }
            }
            if (!canCreateWaypoints) { break; }
            try {
                const waypointsString = waypoints.map(wp => `${wp.lat},${wp.lng}`).join('|');
                const directionsResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: waypointsString, mode: 'bicycling', key: API_KEY } });
                const route = directionsResponse.data.routes[0];
                if (route) {
                    const actualDistance = route.legs.reduce((total, leg) => total + leg.distance.value, 0);
                    const error = Math.abs(actualDistance - targetDistanceMeters);
                    if (error < minError) { minError = error; bestRoute = route; }
                    const errorRatio = targetDistanceMeters / actualDistance;
                    legDistance *= (1 - ADJUSTMENT_FACTOR) + (errorRatio * ADJUSTMENT_FACTOR);
                }
            } catch (dirError) { break; }
        }
        if (minError < 500 && bestRoute) { break; }
    }
    return bestRoute;
}


const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});