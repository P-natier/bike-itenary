let map;
let currentPolyline = null;
let geocoder;
let mapLegend;
let startMarker = null;

// This function is called by the Google Maps script when it's ready.
initializeApp = async () => {
    // Import all necessary Google Maps libraries
    const { Map } = await google.maps.importLibrary("maps");
    const { Geocoder } = await google.maps.importLibrary("geocoding");
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    google.maps.importLibrary("geometry");

    // Read the last starting point from history, if it exists, to center the map
    let initialPosition = { lat: 48.8566, lng: 2.3522 }; // Default to Paris
    try {
        const history = JSON.parse(localStorage.getItem('loopHistory') || '[]');
        if (history.length > 0 && history[0].startLocation) {
            initialPosition = history[0].startLocation;
        }
    } catch (e) {
        console.error("Could not parse history for initial position:", e);
    }
    

    map = new Map(document.getElementById("map"), {
        zoom: 12,
        center: initialPosition,
        mapTypeControl: false,
        fullscreenControl: false,
        streetViewControl: false,
        zoomControl: false,
        mapId: 'BIKE_LOOP_GENERATOR_MAP'
    });

    mapLegend = document.getElementById('map-legend');

    // Initialize services and attach event listeners
    geocoder = new Geocoder();
    document.getElementById('generateBtn').addEventListener('click', generateLoop);

    document.getElementById("toggle-button").addEventListener("click", () => {
        document.getElementById("controls").classList.toggle("open");
    });

    // Fullscreen mode logic
    const fullscreenBtn = document.getElementById("fullscreen-map-btn");
    const exitFullscreenBtn = document.getElementById("exit-fullscreen-map-btn");

    fullscreenBtn.addEventListener("click", () => {
        document.getElementById("controls").style.display = "none";
        fullscreenBtn.style.display = "none";
        exitFullscreenBtn.style.display = "block";
    });
    exitFullscreenBtn.addEventListener("click", () => {
        document.getElementById("controls").style.display = "block";
        fullscreenBtn.style.display = "block";
        exitFullscreenBtn.style.display = "none";
    });

    // Load the history list into the UI on startup
    loadHistory();
};

function generateLoop() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');
    const address = document.getElementById('address').value;
    const gmapsLink = document.getElementById('gmaps-link');

    // Clear previous results from the map and UI
    if (currentPolyline) currentPolyline.setMap(null);
    if (startMarker) startMarker.map = null;
    startMarker = null;

    if (mapLegend) mapLegend.style.display = 'none';
    if (gmapsLink) gmapsLink.style.display = 'none';

    generateBtn.disabled = true;

    // Decide how to get start coordinates
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
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const startLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
                map.setCenter(startLocation);
                document.getElementById('status').textContent = 'Generating your loop...';
                callBackendForLoop(startLocation);
            },
            () => {
                document.getElementById('status').textContent = 'Geolocation failed. Please enable location services or enter an address.';
                document.getElementById('generateBtn').disabled = false;
            }
        );
    } else {
        document.getElementById('status').textContent = 'Geolocation is not supported. Please enter an address.';
        document.getElementById('generateBtn').disabled = false;
    }
}

async function callBackendForLoop(startLocation) {
    const targetDistance = document.getElementById('distance').value;
    const mandatoryWaypoint = document.getElementById('mandatory_waypoint').value;
    const travelMode = document.querySelector('input[name="travel-mode"]:checked').value;
    const routeColor = travelMode === 'WALKING' ? '#0000FF' : '#FF0000';
    
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch('https://bike-loop-backend.onrender.com/api/generate-loop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startLocation, targetDistance: parseFloat(targetDistance), mandatoryWaypoint: mandatoryWaypoint.trim() || null, travelMode }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || "Server responded with an error.");
        }

        const data = await response.json();

        drawRoute(data.polyline, routeColor);

        const distanceInKm = (data.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(data.totalDuration / 60);
        statusDiv.innerHTML = `Generated a <b>${distanceInKm} km</b> loop.<br>Estimated time: <b>${durationInMinutes} minutes</b>.`;

        const gmapsLink = document.getElementById('gmaps-link');
        if (data.googleMapsUrl) {
            gmapsLink.href = data.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

        if (mapLegend) mapLegend.style.display = 'flex';

        // --- THE FIX IS HERE: Create a custom icon element for the marker ---
        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        const iconClass = travelMode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
        
        // 1. Create a new <i> element in JavaScript
        const markerIcon = document.createElement('i');
        
        // 2. Give it the correct Font Awesome classes and our helper class
        markerIcon.className = `${iconClass} fa-2x fa-map-marker`; // fa-2x makes it bigger
        
        // 3. Set its color to match the route
        markerIcon.style.color = routeColor;

        // 4. Create the marker and pass our custom element to the 'content' property
        startMarker = new AdvancedMarkerElement({
            map: map,
            position: startLocation,
            title: 'Start / Finish',
            content: markerIcon, // This replaces the default pin with our icon
        });
        // --- END OF FIX ---

        const addressText = document.getElementById('address').value.trim();
        saveToHistory({
            address: addressText || 'Current Location',
            startLocation: startLocation,
            distance: targetDistance,
            mode: travelMode
        });
        
    } catch (error) {
        clearTimeout(timeoutId);
        document.getElementById('status').textContent = `Error: ${error.message}`;
    } finally {
        generateBtn.disabled = false;
    }
}

function drawRoute(encodedPolyline, strokeColor) {
    const path = google.maps.geometry.encoding.decodePath(encodedPolyline);
    const routePolyline = new google.maps.Polyline({
        path,
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

function saveToHistory(entry) {
    let history = JSON.parse(localStorage.getItem('loopHistory') || '[]');
    history = history.filter(item => !(item.address === entry.address && item.distance === entry.distance && item.mode === entry.mode));
    history.unshift(entry);
    const trimmed = history.slice(0, 5);
    localStorage.setItem('loopHistory', JSON.stringify(trimmed));
    loadHistory();
}

function loadHistory() {
    const historyList = document.getElementById('history-list');
    const history = JSON.parse(localStorage.getItem('loopHistory') || '[]');
    
    historyList.innerHTML = '';

    history.forEach((item) => {
        const li = document.createElement('li');
        
        const iconClass = item.mode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
        const color = item.mode === 'WALKING' ? 'blue' : 'red';

        li.innerHTML = `
            <i class="${iconClass}" style="color: ${color}; width: 20px; text-align: center;"></i> 
            ${item.address} - ${item.distance} km
        `;

        li.addEventListener('click', () => {
            document.getElementById('address').value = item.address === 'Current Location' ? '' : item.address;
            document.getElementById('distance').value = item.distance;
            document.querySelector(`input[name="travel-mode"][value="${item.mode}"]`).checked = true;
        });
        historyList.appendChild(li);
    });
}
