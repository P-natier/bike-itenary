// Add this helper function at the top of your server.js file, after the existing helper functions

function normalizeTransportMode(mode) {
    // Convert frontend mode values to Google Maps API expected values
    const modeMap = {
        'BICYCLING': 'bicycling',
        'WALKING': 'walking',
        'bicycling': 'bicycling',
        'walking': 'walking'
    };
    return modeMap[mode] || 'bicycling'; // default to bicycling if unknown
}

// Updated function signatures to ensure consistent parameter naming
async function generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypointAddress, normalizedTravelMode) {
    const geoResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/geocode/json`, { params: { address: mandatoryWaypointAddress, key: API_KEY } });
    if (!geoResponse.data.results || geoResponse.data.results.length === 0) { throw new Error(`Could not find location for: "${mandatoryWaypointAddress}"`); }
    const mandatoryPoint = geoResponse.data.results[0].geometry.location;

    const directRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: `${mandatoryPoint.lat},${mandatoryPoint.lng}`, mode: normalizedTravelMode, key: API_KEY } });
    const directRoute = directRouteResponse.data.routes[0];
    const directDistance = directRoute.legs.reduce((sum, leg) => sum + leg.distance.value, 0);

    const targetDistanceMeters = targetDistance * 1000;
    const distanceDeficit = targetDistanceMeters - directDistance;

    if (distanceDeficit <= 500) {
        return { route: directRoute, waypointsUsed: [mandatoryPoint] };
    }
    
    const detourLegDistance = (distanceDeficit / 2) / 2;
    const bearingOut = getBearing(startLocation, mandatoryPoint);
    const detourBearingOut = (bearingOut + 90 * (Math.random() > 0.5 ? 1 : -1) + 360) % 360;
    const midpointOut = { lat: (startLocation.lat + mandatoryPoint.lat) / 2, lng: (startLocation.lng + mandatoryPoint.lng) / 2 };
    const theoreticalDetour1 = calculateDestinationPoint(midpointOut.lat, midpointOut.lng, detourBearingOut, detourLegDistance / 1000);
    
    const bearingIn = getBearing(mandatoryPoint, startLocation);
    const detourBearingIn = (bearingIn + 90 * (Math.random() > 0.5 ? 1 : -1) + 360) % 360;
    const midpointIn = { lat: (mandatoryPoint.lat + startLocation.lat) / 2, lng: (mandatoryPoint.lng + startLocation.lng) / 2 };
    const theoreticalDetour2 = calculateDestinationPoint(midpointIn.lat, midpointIn.lng, detourBearingIn, detourLegDistance / 1000);
    
    const finalWaypointsForRequest = [`${theoreticalDetour1.lat},${theoreticalDetour1.lng}`, `${mandatoryPoint.lat},${mandatoryPoint.lng}`, `${theoreticalDetour2.lat},${theoreticalDetour2.lng}`];
    
    const finalRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: finalWaypointsForRequest.join('|'), mode: normalizedTravelMode, key: API_KEY } });

    return { route: finalRouteResponse.data.routes[0], waypointsUsed: [theoreticalDetour1, mandatoryPoint, theoreticalDetour2] };
}

async function generateRandomLoop(startLocation, targetDistance, normalizedTravelMode) {
    const MAIN_ATTEMPTS = 10;
    const REFINE_ITERATIONS = 3;
    const ADJUSTMENT_FACTOR = 0.75;
    const targetDistanceMeters = targetDistance * 1000;
    let bestRoute = null;
    let minError = Infinity;
    let waypointsForBestRoute = [];

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
                const directionsResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, {
                    params: {
                        origin: `${startLocation.lat},${startLocation.lng}`,
                        destination: `${startLocation.lat},${startLocation.lng}`,
                        waypoints: waypointsString,
                        mode: normalizedTravelMode, // Using normalized travel mode
                        key: API_KEY
                    }
                });
                const route = directionsResponse.data.routes[0];
                if (route) {
                    const actualDistance = route.legs.reduce((total, leg) => total + leg.distance.value, 0);
                    const error = Math.abs(actualDistance - targetDistanceMeters);
                    if (error < minError) {
                        minError = error;
                        bestRoute = route;
                        waypointsForBestRoute = waypoints;
                    }
                    const errorRatio = targetDistanceMeters / actualDistance;
                    legDistance *= (1 - ADJUSTMENT_FACTOR) + (errorRatio * ADJUSTMENT_FACTOR);
                }
            } catch (dirError) { break; }
        }
        if (minError < 500 && bestRoute) { break; }
    }
    return { 
        route: bestRoute,
        waypointsUsed: waypointsForBestRoute
    };
}

// Then update your main API endpoint to use this function:
app.post('/api/generate-loop', async (req, res) => {
    const { startLocation, targetDistance, mandatoryWaypoint, travelMode = 'bicycling' } = req.body;

    if (!startLocation || !targetDistance) {
        return res.status(400).json({ error: 'Missing startLocation or targetDistance' });
    }

    try {
        // Normalize the travel mode
        const normalizedTravelMode = normalizeTransportMode(travelMode);
        
        let result;
        if (mandatoryWaypoint) {
            console.log(`Generating loop with mandatory waypoint: "${mandatoryWaypoint}" for mode: ${normalizedTravelMode}`);
            result = await generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypoint, normalizedTravelMode);
        } else {
            console.log(`Generating a random loop for mode: ${normalizedTravelMode}`);
            result = await generateRandomLoop(startLocation, targetDistance, normalizedTravelMode);
        }

        if (!result || !result.route) {
            throw new Error("Could not generate a valid route.");
        }
        
        let googleMapsUrl = 'https://www.google.com/maps/dir/';
        const origin = `${startLocation.lat},${startLocation.lng}`;
        const destination = origin;
        const waypointsString = result.waypointsUsed.map(wp => `${wp.lat},${wp.lng}`).join('/');
        
        const dirflg = normalizedTravelMode === 'walking' ? 'w' : 'b';
        googleMapsUrl += `${origin}/${waypointsString}/${destination}?dirflg=${dirflg}`;

        res.json({
            polyline: result.route.overview_polyline.points,
            totalDistance: result.route.legs.reduce((total, leg) => total + leg.distance.value, 0),
            totalDuration: result.route.legs.reduce((total, leg) => total + leg.duration.value, 0),
            googleMapsUrl: googleMapsUrl
        });

    } catch (error) {
        console.error("Error in main handler:", error.message);
        res.status(500).json({ error: 'Failed to generate loop itinerary.', details: error.message });
    }
});
