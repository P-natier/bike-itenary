let map;
let currentPolyline = null;
let geocoder;
let mapLegend;
// The startMarker will now be an AdvancedMarkerElement
let startMarker = null;

// This function is called by the Google Maps script. We redefine the empty one from the HTML.
initializeApp = async () => {
    // Import the base libraries
    const { Map } = await google.maps.importLibrary("maps");
    const { Geocoder } = await google.maps.importLibrary("geocoding");
    // Import the new 'marker' library
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    google.maps.importLibrary("geometry");

    const initialPosition = { lat: 48.8566, lng: 2.3522 };
    map = new Map(document.getElementById("map"), {
        zoom: 12,
        center: initialPosition,
        mapTypeControl: false,
        fullscreenControl: false,
        streetViewControl: false,
        zoomControl: false,
        // A mapId is required for Advanced Markers
        mapId: 'BIKE_LOOP_GENERATOR_MAP' 
    });

    mapLegend = document.createElement('div');
    mapLegend.id = 'map-legend';
    map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(mapLegend);

    geocoder = new Geocoder();
    document.getElementById('generateBtn').addEventListener('click', generateLoop);
};

function generateLoop() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');
    const address = document.getElementById('address').value;
    const gmapsLink = document.getElementById('gmaps-link');

    // Clean up all UI elements from the previous run
    if (currentPolyline) {
        currentPolyline.setMap(null);
    }
    if (startMarker) {
        // The new way to remove a marker is to set its map property to null
        startMarker.map = null;
        startMarker = null;
    }
    if (mapLegend) {
        mapLegend.style.display = 'none';
    }
    if (gmapsLink) {
        gmapsLink.style.display = 'none';
    }

    generateBtn.disabled = true;

    if (address.trim() !== "") {
        statusDiv.textContent = `Finding "${address}"...`;
        geocodeAddress(address);
    } else {
        statusDiv.textContent = 'Getting your current location...';
        useCurrentLocation();
    }
}

function geocodeAddress(address) {
    geocoder.geocode({ 'address': address }, (results, status) => {
        if (status === 'OK') {
            const startLocation = { lat: results[0].geometry.location.lat(), lng: results[0].geometry.location.lng() };
            map.setCenter(startLocation);
            document.getElementById('status').textContent = 'Generating your loop...';
            callBackendForLoop(startLocation);
        } else {
            document.getElementById('status').textContent = `Could not find that address. Reason: ${status}`;
            document.getElementById('generateBtn').disabled = false;
        }
    });
}

function useCurrentLocation() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const startLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
                map.setCenter(startLocation);
                document.getElementById('status').textContent = 'Generating your loop...';
                callBackendForLoop(startLocation);
            },
            () => {
                statusDiv.textContent = 'Geolocation failed. Please enable location services or enter an address.';
                generateBtn.disabled = false;
            }
        );
    } else {
        statusDiv.textContent = 'Geolocation is not supported. Please enter an address.';
        generateBtn.disabled = false;
    }
}

async function callBackendForLoop(startLocation) {
    const targetDistance = document.getElementById('distance').value;
    const mandatoryWaypoint = document.getElementById('mandatory_waypoint').value;
    const travelMode = document.querySelector('input[name="travel-mode"]:checked').value;
    
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch('https://bike-loop-backend.onrender.com/api/generate-loop', { // Your public Render backend URL
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startLocation,
                targetDistance: parseFloat(targetDistance),
                mandatoryWaypoint: mandatoryWaypoint.trim() === "" ? null : mandatoryWaypoint,
                travelMode: travelMode,
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'The server returned an error.');
        }

        const data = await response.json();
        
        drawRoute(data.polyline);
        
        const distanceInKm = (data.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(data.totalDuration / 60);
        statusDiv.innerHTML = `Generated a <b>${distanceInKm} km</b> loop. <br> Estimated time: <b>${durationInMinutes} minutes</b>.`;
        
        const gmapsLink = document.getElementById('gmaps-link');
        if (data.googleMapsUrl && gmapsLink) {
            gmapsLink.href = data.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

        const iconClass = travelMode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
        mapLegend.innerHTML = `<i class="${iconClass}"></i> Loop: ${distanceInKm} km`;
        mapLegend.style.display = 'block';

        // Use the new AdvancedMarkerElement
        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        startMarker = new AdvancedMarkerElement({
            map: map,
            position: startLocation,
            title: 'Start / Finish',
        });
        
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Error:', error);
        if (error.name === 'AbortError') {
            statusDiv.textContent = 'Error: The server took too long to respond. Please try again.';
        } else {
            statusDiv.textContent = `Error: ${error.message}`;
        }
    } finally {
        generateBtn.disabled = false;
    }
}

function drawRoute(encodedPolyline) {
    const path = google.maps.geometry.encoding.decodePath(encodedPolyline);
    const routePolyline = new google.maps.Polyline({
        path: path,
        geodesic: true,
        strokeColor: '#FF0000',
        strokeOpacity: 0.8,
        strokeWeight: 5
    });
    routePolyline.setMap(map);
    currentPolyline = routePolyline;
    const bounds = new google.maps.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    map.fitBounds(bounds);
}
