import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SERVER_URL = 'http://localhost:4000';
const ROOM = 'room1';

function getStatus(score) {
  if (score >= 70) return 'Focused';
  if (score < 40) return 'Distracted';
  return 'Normal';
}

function getStatusColor(status) {
  if (status === 'Focused') return '#16a34a';
  if (status === 'Distracted') return '#dc2626';
  return '#fbbf24';
}

const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function App() {
  const localVideoRef = useRef(null);
  const [socket, setSocket] = useState(null);
  const [socketId, setSocketId] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [remoteVideos, setRemoteVideos] = useState([]);
  const [score, setScore] = useState(50);
  const [status, setStatus] = useState('Normal');
  const [joined, setJoined] = useState(false);
  const peersRef = useRef({});
  const lastActiveRef = useRef(Date.now());
  const localStreamRef = useRef(null);

  const participantName = useMemo(() => `Guest-${Math.floor(Math.random() * 9000 + 1000)}` , []);

  useEffect(() => {
    const s = io(SERVER_URL);
    setSocket(s);

    s.on('connect', () => {
      setSocketId(s.id);
      s.emit('joinRoom', { room: ROOM, name: participantName });
    });

    s.on('all-users', (users) => {
      users.forEach((userId) => {
        createPeerConnection(userId, true);
      });
      setJoined(true);
    });

    s.on('user-joined', ({ id }) => {
      createPeerConnection(id, false);
    });

    s.on('offer', async ({ sdp, callerId, callerName }) => {
      const pc = createPeerConnection(callerId, false);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit('answer', { target: callerId, sdp: pc.localDescription });
    });

    s.on('answer', async ({ sdp, responderId }) => {
      const pc = peersRef.current[responderId]?.pc;
      if (pc && sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    s.on('ice-candidate', async ({ candidate, from }) => {
      const pc = peersRef.current[from]?.pc;
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('Failed to add ICE candidate', err);
        }
      }
    });

    s.on('participantsUpdated', (updated) => {
      setParticipants(updated);
    });

    return () => {
      s.disconnect();
    };
  }, [participantName]);

  useEffect(() => {
    async function startMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Unable to access camera/mic:', err);
      }
    }
    startMedia();
  }, []);

  useEffect(() => {
    const handleActivity = () => {
      lastActiveRef.current = Date.now();
      setScore((prev) => Math.min(100, prev + 2));
    };

    const handleVisibility = () => {
      if (document.hidden) {
        setScore((prev) => Math.max(0, prev - 5));
      } else {
        lastActiveRef.current = Date.now();
        setScore((prev) => Math.min(100, prev + 3));
      }
    };

    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keydown', handleActivity);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastActiveRef.current > 5000) {
        setScore((prev) => Math.max(0, prev - 1));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const newStatus = getStatus(score);
    setStatus(newStatus);
  }, [score]);

  useEffect(() => {
    if (!socketId || !socket) return;
    socket.emit('updateFocus', { id: socketId, focus: score, status });
  }, [score, status, socket, socketId]);

  const createPeerConnection = (userId, isInitiator) => {
    if (peersRef.current[userId]) return peersRef.current[userId].pc;

    const pc = new RTCPeerConnection(iceServers);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('ice-candidate', { target: userId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      setRemoteVideos((current) => {
        const stream = event.streams[0];
        const exists = current.some((item) => item.id === userId);
        if (exists) return current;
        return [...current, { id: userId, stream }];
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setRemoteVideos((current) => current.filter((item) => item.id !== userId));
        pc.close();
        delete peersRef.current[userId];
      }
    };

    peersRef.current[userId] = { pc };

    if (isInitiator && socket) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('offer', { target: userId, sdp: pc.localDescription, callerId: socket.id, callerName: participantName });
        } catch (err) {
          console.error('Offer failed:', err);
        }
      };
    }

    return pc;
  };

  const myParticipant = participants.find((p) => p.id === socketId) || { name: participantName, focus: score, status };

  return (
    <div className="page-shell">
      <header>
        <h1>AI Focus Meeting</h1>
        <p>Use your camera and engage with the tab. Focus is updated live.</p>
      </header>

      <div className="layout-grid">
        <section className="video-panel">
          <div className="video-grid">
            <div className="video-card local-video">
              <video ref={localVideoRef} autoPlay muted playsInline />
              <div className="video-label">You ({myParticipant.name})</div>
            </div>
            {remoteVideos.map((remote) => (
              <div key={remote.id} className="video-card">
                <VideoPlayer stream={remote.stream} />
                <div className="video-label">Participant</div>
              </div>
            ))}
          </div>
        </section>

        <aside className="focus-panel">
          <div className="focus-summary" style={{ borderColor: getStatusColor(myParticipant.status) }}>
            <h2>Your focus</h2>
            <p className="focus-value">{score}</p>
            <p className="focus-status" style={{ color: getStatusColor(status) }}>{status}</p>
          </div>

          <div className="participants-list">
            <h2>Participants</h2>
            {participants.map((participant) => (
              <div key={participant.id} className="participant-card" style={{ borderLeftColor: getStatusColor(participant.status) }}>
                <strong>{participant.name}</strong>
                <span>Score: {participant.focus}</span>
                <span>Status: {participant.status}</span>
              </div>
            ))}
            {!participants.length && <p>Waiting for participants...</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function VideoPlayer({ stream }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return <video ref={videoRef} autoPlay playsInline />;
}

export default App;
