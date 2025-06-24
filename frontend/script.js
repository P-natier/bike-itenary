// Add an event listener that waits for the entire HTML document to be loaded and ready.
// ALL of our code will now live inside this block.
document.addEventListener('DOMContentLoaded', () => {

    // --- Global variables, scoped to our DOM-ready function ---
    let map;
    let currentPolyline = null;
    let geocoder;
    let mapLegend;
    let startMarker = null;

    // --- We make initializeApp a global function by attaching it to the 'window' object ---
    // This ensures that the Google Maps callback can always find it.
    window.initializeApp = async () => {
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

        // Initialize the geocoder service
        geocoder = new Geocoder();
        
        // --- Safely attach all event listeners now that the DOM is ready ---
        mapLegend = document.getElementById('map-legend');
        document.getElementById('generateBtn').addEventListener('click', generateLoop);

        const toggleButton = document.getElementById('logo-toggle-button'); // UPDATED ID
        const controlsPanel = document.getElementById('controls');
        toggleButton.addEventListener('click', () => {
            controlsPanel.classList.toggle('open');
        });

        // Fullscreen mode logic
        const fullscreenBtn = document.getElementById("fullscreen-map-btn");
        const exitFullscreenBtn = document.getElementById("exit-fullscreen-map-btn");

        if (fullscreenBtn && exitFullscreenBtn) {
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
        }

        // Load the history list into the UI on startup
        loadHistory();
    };


    // --- All other functions live inside the DOMContentLoaded listener ---

    function clearUI() {
        if (currentPolyline) currentPolyline.setMap(null);
        if (startMarker) startMarker.map = null;
        startMarker = null;
        if (mapLegend) mapLegend.style.display = 'none';
        const gmapsLink = document.getElementById('gmaps-link');
        if (gmapsLink) gmapsLink.style.display = 'none';
        document.getElementById('status').textContent = 'Enter a starting point and distance, then click Generate.';
    }

    function generateLoop() {
        clearUI();
        const generateBtn = document.getElementById('generateBtn');
        const address = document.getElementById('address').value;
        generateBtn.disabled = true;

        if (address.trim() !== "") {
            document.getElementById('status').textContent = `Finding "${address}"...`;
            geocodeAddress(address);
        } else {
            document.getElementById('status').textContent = 'Getting your current location...';
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
        const enhanceWithAI = document.getElementById('ai-toggle').checked;
        
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
                mandatoryWaypoint: mandatoryWaypoint.trim() || null,
                travelMode,
                enhanceWithAI: enhanceWithAI // UPDATED: Send the flag
            }),
            signal: controller.signal
        });

            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || "Server responded with an error.");
            }

            const data = await response.json();
            
            const addressText = document.getElementById('address').value.trim();
            const historyEntry = {
                address: addressText || 'Current Location',
                startLocation: startLocation,
                distance: targetDistance,
                mode: travelMode,
                polyline: data.polyline,
                totalDistance: data.totalDistance,
                totalDuration: data.totalDuration,
                googleMapsUrl: data.googleMapsUrl
            };
            
            displayRouteFromHistory(historyEntry);
            saveToHistory(historyEntry);
            
        } catch (error) {
            clearTimeout(timeoutId);
            document.getElementById('status').textContent = `Error: ${error.message}`;
        } finally {
            generateBtn.disabled = false;
        }
    }

    async function displayRouteFromHistory(historyItem) {
        clearUI();

        const routeColor = historyItem.mode === 'WALKING' ? '#0000FF' : '#FF0000';
        const distanceInKm = (historyItem.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(historyItem.totalDuration / 60);

        drawRoute(historyItem.polyline, routeColor);
        
        document.getElementById('status').innerHTML = `Displaying route from history.<br><b>${distanceInKm} km</b> loop, approx. <b>${durationInMinutes} minutes</b>.`;

        const gmapsLink = document.getElementById('gmaps-link');
        if (historyItem.googleMapsUrl) {
            gmapsLink.href = historyItem.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

        if (mapLegend) {
            const iconClassLegend = historyItem.mode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
            mapLegend.innerHTML = `<i class="${iconClassLegend}" style="color: ${routeColor};"></i> Loop: ${distanceInKm} km`;
            mapLegend.style.display = 'flex';
        }

        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        const iconClassMarker = historyItem.mode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
        const markerIcon = document.createElement('i');
        markerIcon.className = `${iconClassMarker} fa-2x fa-map-marker`;
        markerIcon.style.color = routeColor;

        startMarker = new AdvancedMarkerElement({
            map: map,
            position: historyItem.startLocation,
            title: 'Start / Finish',
            content: markerIcon,
        });
    }

    function drawRoute(encodedPolyline, strokeColor) {
        const path = google.maps.geometry.encoding.decodePath(encodedPolyline);
        currentPolyline = new google.maps.Polyline({
            path,
            geodesic: true,
            strokeColor,
            strokeOpacity: 0.8,
            strokeWeight: 5
        });
        currentPolyline.setMap(map);

        const bounds = new google.maps.LatLngBounds();
        path.forEach(point => bounds.extend(point));
        map.fitBounds(bounds);
    }

    function saveToHistory(entry) {
        let history = JSON.parse(localStorage.getItem('loopHistory') || '[]');
        history = history.filter(item => item.googleMapsUrl !== entry.googleMapsUrl);
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
                displayRouteFromHistory(item);
            });
            historyList.appendChild(li);
        });
    }

}); // --- End of the DOMContentLoaded listener ---
