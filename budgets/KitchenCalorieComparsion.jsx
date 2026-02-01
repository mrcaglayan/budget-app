import React, { useState, useEffect } from 'react'
import axios from 'axios'

function KitchenCalorieComparsion() {


    const [schools, setSchools] = useState([])

    useEffect(() => {
        async function fetchSchoolsList() {
            const { data } = await axios.get('/schools-kitchen')
            setSchools(data)

        }
        fetchSchoolsList()
    }, []);
    console.log(schools)

    return (
        <div>
            {schools.map((school) =>
                <li key={school.id}>{school.school_name}</li>
            )
            }
        </div>
    )
}

export default KitchenCalorieComparsion