let map;
let currentPolyline = null;
let geocoder;
let mapLegend;
let startMarker = null;

initializeApp = async () => {
    const { Map } = await google.maps.importLibrary("maps");
    const { Geocoder } = await google.maps.importLibrary("geocoding");
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
        mapId: 'BIKE_LOOP_GENERATOR_MAP'
    });

    mapLegend = document.createElement('div');
    mapLegend.id = 'map-legend';
    map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(mapLegend);

    geocoder = new Geocoder();
    document.getElementById('generateBtn').addEventListener('click', generateLoop);

    // Toggle sidebar
    const toggleBtn = document.getElementById("toggle-button");
    const controls = document.getElementById("controls");
    toggleBtn.addEventListener("click", () => {
        controls.classList.toggle("open");
    });
};

function generateLoop() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');
    const address = document.getElementById('address').value;
    const gmapsLink = document.getElementById('gmaps-link');

    if (currentPolyline) currentPolyline.setMap(null);
    if (startMarker) startMarker.map = null;
    startMarker = null;

    mapLegend.style.display = 'none';
    gmapsLink.style.display = 'none';

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
            const startLocation = {
                lat: results[0].geometry.location.lat(),
                lng: results[0].geometry.location.lng()
            };
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
                const startLocation = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                map.setCenter(startLocation);
                statusDiv.textContent = 'Generating your loop...';
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
        const response = await fetch('https://bike-loop-backend.onrender.com/api/generate-loop', {
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
        if (!response.ok) throw new Error(await response.text());

        const data = await response.json();

        drawRoute(data.polyline, travelMode);

        const distanceInKm = (data.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(data.totalDuration / 60);
        statusDiv.innerHTML = `Generated a <b>${distanceInKm} km</b> loop.<br>Estimated time: <b>${durationInMinutes} minutes</b>.`;

        const gmapsLink = document.getElementById('gmaps-link');
        if (data.googleMapsUrl) {
            gmapsLink.href = data.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

        const iconClass = travelMode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
        mapLegend.innerHTML = `<i class="${iconClass}"></i> Loop: ${distanceInKm} km`;
        mapLegend.style.display = 'block';

        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        startMarker = new AdvancedMarkerElement({
            map: map,
            position: startLocation,
            title: 'Start / Finish',
        });

    } catch (error) {
        clearTimeout(timeoutId);
        statusDiv.textContent = `Error: ${error.message}`;
    } finally {
        generateBtn.disabled = false;
    }
}

function drawRoute(encodedPolyline, travelMode) {
    const path = google.maps.geometry.encoding.decodePath(encodedPolyline);
    const strokeColor = travelMode === 'WALKING' ? '#0000FF' : '#FF0000'; // blue for walking, red for bike
    const routePolyline = new google.maps.Polyline({
        path: path,
        geodesic: true,
        strokeColor,
        strokeOpacity: 0.8,
        strokeWeight: 5
    });
    routePolyline.setMap(map);
    currentPolyline = routePolyline;

    const bounds = new google.maps.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    map.fitBounds(bounds);
}
