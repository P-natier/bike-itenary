let map;
let directionsService;
let directionsRenderer;
let markers = [];
let lastStartLocation = '';

function initializeApp() {
  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 13,
    center: { lat: 45.75, lng: 4.85 },
    disableDefaultUI: true,
  });

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({ suppressMarkers: true });
  directionsRenderer.setMap(map);

  document.getElementById("generateBtn").addEventListener("click", generateLoop);
  document.getElementById("toggle-button").addEventListener("click", toggleControls);
  document.getElementById("fullscreen-map-btn").addEventListener("click", enterFullscreenMap);
  document.getElementById("exit-fullscreen-map-btn").addEventListener("click", exitFullscreenMap);

  loadHistory();
  preloadLastStart();
}

function toggleControls() {
  const controls = document.getElementById("controls");
  controls.classList.toggle("open");
}

function enterFullscreenMap() {
  document.getElementById("controls").style.display = "none";
  document.getElementById("fullscreen-map-btn").style.display = "none";
  document.getElementById("exit-fullscreen-map-btn").style.display = "inline-block";
}

function exitFullscreenMap() {
  document.getElementById("controls").style.display = "block";
  document.getElementById("fullscreen-map-btn").style.display = "inline-block";
  document.getElementById("exit-fullscreen-map-btn").style.display = "none";
}

function preloadLastStart() {
  const history = JSON.parse(localStorage.getItem("routes") || "[]");
  if (history.length > 0) {
    document.getElementById("address").value = history[0].start || "";
  }
}

function generateLoop() {
  const address = document.getElementById("address").value;
  const distanceKm = parseFloat(document.getElementById("distance").value);
  const mode = document.querySelector('input[name="travel-mode"]:checked').value;
  const waypoint = document.getElementById("mandatory_waypoint").value.trim();

  if (!address || isNaN(distanceKm) || distanceKm <= 0) {
    alert("Please enter a valid address and distance.");
    return;
  }

  const service = new google.maps.places.PlacesService(map);
  const geocoder = new google.maps.Geocoder();

  geocoder.geocode({ address }, function(results, status) {
    if (status === "OK" && results[0]) {
      const start = results[0].geometry.location;
      const loopDistance = distanceKm * 1000;

      buildLoop(start, loopDistance, waypoint, mode);
      lastStartLocation = address;
    } else {
      alert("Geocode was not successful: " + status);
    }
  });
}

function buildLoop(start, distance, waypoint, mode) {
  // Simulate loop by going to point X then back (simplified)
  const heading = Math.random() * 360;
  const mid = google.maps.geometry.spherical.computeOffset(start, distance / 2, heading);

  const waypoints = [];
  if (waypoint) {
    waypoints.push({ location: waypoint, stopover: true });
  }

  directionsService.route(
    {
      origin: start,
      destination: start,
      waypoints: [...waypoints, { location: mid, stopover: true }],
      travelMode: google.maps.TravelMode[mode],
      optimizeWaypoints: true,
    },
    (result, status) => {
      if (status === "OK") {
        directionsRenderer.setDirections(result);
        clearMarkers();
        const route = result.routes[0];

        // Add custom icon at start
        const iconUrl = mode === "BICYCLING"
          ? "https://cdn-icons-png.flaticon.com/512/1140/1140497.png"
          : "https://cdn-icons-png.flaticon.com/512/5111/5111532.png";

        const marker = new google.maps.Marker({
          position: route.legs[0].start_location,
          map,
          icon: {
            url: iconUrl,
            scaledSize: new google.maps.Size(32, 32),
          },
        });
        markers.push(marker);

        const totalMeters = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
        const duration = route.legs.reduce((sum, leg) => sum + leg.duration.value, 0);
        const km = (totalMeters / 1000).toFixed(2);
        const minutes = Math.round(duration / 60);

        document.getElementById("status").textContent = `Generated a ${km} km loop. Estimated time: ${minutes} minutes.`;
        document.getElementById("gmaps-link").style.display = "block";
        document.getElementById("gmaps-link").href = `https://www.google.com/maps/dir/?api=1&origin=${route.legs[0].start_location.lat()},${route.legs[0].start_location.lng()}&destination=${route.legs[0].start_location.lat()},${route.legs[0].start_location.lng()}&travelmode=${mode.toLowerCase()}`;

        saveToHistory(lastStartLocation || route.legs[0].start_address, km, mode);
        loadHistory();
      } else {
        alert("Could not generate loop: " + status);
      }
    }
  );
}

function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function saveToHistory(start, km, mode) {
  const routes = JSON.parse(localStorage.getItem("routes") || "[]");
  routes.unshift({ start, km, mode });
  localStorage.setItem("routes", JSON.stringify(routes.slice(0, 10)));
}

function loadHistory() {
  const list = document.getElementById("history-list");
  list.innerHTML = "";

  const routes = JSON.parse(localStorage.getItem("routes") || "[]");
  routes.forEach(r => {
    const li = document.createElement("li");
    const icon = r.mode === "BICYCLING" ? "fa-bicycle" : "fa-person-walking";
    li.innerHTML = `<i class="fa-solid ${icon}"></i> ${r.start} — ${r.km} km`;
    list.appendChild(li);
  });
}
