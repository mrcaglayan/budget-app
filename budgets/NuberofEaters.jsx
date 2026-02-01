import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';

function NuberofEaters() {
    const [schools, setSchools] = useState([]);
    const [eaters, setEaters] = useState({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    // 1) reusable fetch
    const fetchSchools = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const { data } = await axios.get('/schoolListForEaters');
            const list = Array.isArray(data) ? data : [];
            setSchools(list);

            // prefill from DB
            const init = {};
            list.forEach((s) => {
                init[s.id] = s.eating_number ?? '';
            });
            setEaters(init);

            // if you want to see it:
            console.log('fetched schools:', list);
            console.log('prefilled eaters:', init);
        } catch (err) {
            console.error(err);
            setError(err.response?.data?.error || 'Okul listesi alınamadı.');
        } finally {
            setLoading(false);
        }
    }, []);

    // 2) initial load
    useEffect(() => {
        fetchSchools();
    }, [fetchSchools]);

    const handleChange = (schoolId, value) => {
        const clean = value.replace(/[^\d]/g, '');
        setEaters((prev) => ({
            ...prev,
            [schoolId]: clean,
        }));
    };

    const handleSave = async () => {
        setSaving(true);
        setError('');
        setSuccess('');
        try {
            const rows = schools.map((s) => ({
                school_id: s.id,
                eaters: Number(eaters[s.id] || 0),
            }));

            await axios.post('/schoolEaters', { rows });

            setSuccess('Tüm kayıtlar kaydedildi ✅');

            // 3) refresh from DB → "Mevcut" column updates
            await fetchSchools();
        } catch (err) {
            console.error(err);
            setError(err.response?.data?.error || 'Kaydederken hata oluştu.');
        } finally {
            setSaving(false);
        }
    };

    // optional: see when eaters changes (no stale log)
    // useEffect(() => {
    //   console.log('eaters state ->', eaters);
    // }, [eaters]);

    return (
        <div className="p-4">
            <h2 className="text-lg font-semibold mb-3">Okul Yemek Yiyen Sayıları</h2>

            {loading && <p>Yükleniyor...</p>}
            {error && <p className="text-red-600 mb-2">{error}</p>}
            {success && <p className="text-green-600 mb-2">{success}</p>}

            {!loading && (
                <div className="overflow-x-auto border rounded">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-100">
                            <tr>
                                <th className="px-3 py-2 text-left">#</th>
                                <th className="px-3 py-2 text-left">Okul Adı</th>
                                <th className="px-3 py-2 text-left">Mevcut</th>
                                <th className="px-3 py-2 text-left">Yeni Yemek Yiyen Sayısı</th>
                            </tr>
                        </thead>
                        <tbody>
                            {schools.map((school, idx) => (
                                <tr key={school.id} className="border-t">
                                    <td className="px-3 py-2">{idx + 1}</td>
                                    <td className="px-3 py-2">{school.school_name}</td>
                                    <td className="px-3 py-2">
                                        {school.eating_number ?? 0}
                                    </td>
                                    <td className="px-3 py-2">
                                        <input
                                            type="number"
                                            min="0"
                                            value={eaters[school.id] ?? ''}
                                            onChange={(e) => handleChange(school.id, e.target.value)}
                                            className="border rounded px-2 py-1 w-32"
                                            placeholder="0"
                                        />
                                    </td>
                                </tr>
                            ))}

                            {schools.length === 0 && (
                                <tr>
                                    <td colSpan={4} className="px-3 py-4 text-center text-gray-500">
                                        Kayıt yok
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="mt-4">
                <button
                    onClick={handleSave}
                    disabled={saving || loading || schools.length === 0}
                    className={`px-4 py-2 rounded text-white ${saving ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'
                        }`}
                >
                    {saving ? 'Kaydediliyor...' : 'Kaydet'}
                </button>
            </div>
        </div>
    );
}

export default NuberofEaters;
