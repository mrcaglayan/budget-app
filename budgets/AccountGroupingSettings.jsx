import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'

const ItemTypes = { ACCOUNT: 'account' }

const DraggableAccount = ({ account, className }) => {
    const [{ isDragging }, drag] = useDrag(() => ({
        type: ItemTypes.ACCOUNT,
        item: account,
        collect: monitor => ({ isDragging: !!monitor.isDragging() })
    }))
    return (
        <div
            ref={drag}
            className={`${className || ''} cursor-move ${isDragging ? 'opacity-50' : ''}`}
        >
            {account.name}
        </div>
    )
}

const DropContainer = ({ children, onDrop, highlight, title }) => {
    const [{ isOver }, drop] = useDrop(() => ({
        accept: ItemTypes.ACCOUNT,
        drop: (item) => onDrop(item),
        collect: monitor => ({ isOver: !!monitor.isOver() })
    }))

    return (
        <div
            ref={drop}
            className={`border p-2 rounded min-h-[60px] ${highlight ? 'bg-yellow-50' : ''}`}
            style={{ backgroundColor: isOver ? '#e0f7fa' : '' }}
        >
            {title && <strong className="mb-1 block">{title}</strong>}
            {children}
        </div>
    )
}

function AccountGroupingSettings() {
    const [accountsList, setAccountsList] = useState([])
    const [groupLevels, setGroupLevels] = useState({ group_level_name: "" })
    const [allGroupLevels, setAllGroupLevels] = useState([])
    const [editId, setEditId] = useState(null)
    const [groupedAccounts, setGroupedAccounts] = useState({})
    const [showGroupModal, setShowGroupModal] = useState(false)

    useEffect(() => {
        fetchAccountsList()
        fetchGroupLevels()
        fetchGroupedAccounts()
    }, [])

    const fetchAccountsList = async () => {
        try {
            const { data } = await axios.get('/accounts-list')
            setAccountsList(data)
        } catch (err) { console.error(err) }
    }

    const fetchGroupLevels = async () => {
        try {
            const { data } = await axios.get('/group-levels')
            setAllGroupLevels(data)
        } catch (err) { console.error(err) }
    }

    const fetchGroupedAccounts = async () => {
        try {
            const { data } = await axios.get('/group-accounts')
            const grouped = {}
            data.forEach(item => { grouped[item.groupId] = item.accounts })
            setGroupedAccounts(grouped)

            // Remove assigned accounts from main list
            const assignedIds = data.flatMap(item => item.accounts.map(acc => acc.id))
            setAccountsList(prev => prev.filter(acc => !assignedIds.includes(acc.id)))
        } catch (err) { console.error(err) }
    }

    const handleSaveGroupLevel = async () => {
        try {
            if (editId) await axios.put(`/group-levels/${editId}`, groupLevels)
            else await axios.post('/group-levels', groupLevels)
            setGroupLevels({ group_level_name: "" })
            setEditId(null)
            fetchGroupLevels()
        } catch (err) { console.error(err) }
    }

    const handleEdit = (group) => {
        setGroupLevels({ group_level_name: group.group_level_name })
        setEditId(group.id)
    }

    const handleDelete = async (id) => {
        try {
            await axios.delete(`/group-levels/${id}`)
            fetchGroupLevels()
            setGroupedAccounts(prev => {
                const copy = { ...prev }
                delete copy[id]
                return copy
            })
        } catch (err) { console.error(err) }
    }

    const handleMoveAccount = async (account, targetGroupId, sourceGroupId = null) => {
        // Remove from source
        if (sourceGroupId === null) setAccountsList(prev => prev.filter(a => a.id !== account.id))
        else setGroupedAccounts(prev => ({
            ...prev,
            [sourceGroupId]: prev[sourceGroupId].filter(a => a.id !== account.id)
        }))

        // Add to target
        if (targetGroupId === null) setAccountsList(prev => [...prev, account])
        else setGroupedAccounts(prev => ({
            ...prev,
            [targetGroupId]: [...(prev[targetGroupId] || []), account]
        }))

        try {
            if (targetGroupId === null) {
                // Moving back to main list → remove assignment in backend
                await axios.delete('/group-accounts/remove', { data: { accountId: account.id } })
            } else {
                // Assign to new group
                await axios.post('/group-accounts', {
                    groupId: targetGroupId,
                    accountIds: [account.id]
                })
            }
        } catch (err) {
            console.error(err)
            alert('Failed to update group assignment')
        }
    }

    return (
        <DndProvider backend={HTML5Backend}>
            <div className="p-4 h-screen flex flex-col">

                {/* Button to open Group Levels modal */}
                <button
                    onClick={() => setShowGroupModal(true)}
                    className="bg-blue-500 text-white px-3 py-1 mb-4 rounded"
                >
                    Add/Manage Group Levels
                </button>

                {/* Main content area */}
                <div className="flex gap-4 flex-1 overflow-hidden">

                    {/* Middle Column: Group Level Boxes */}
                    <div className="w-1/2 border p-2 overflow-auto flex flex-col gap-2">
                        <h2 className="font-bold mb-2">Group Level Boxes</h2>
                        {allGroupLevels.map(group => (
                            <DropContainer
                                key={group.id}
                                onDrop={(account) => handleMoveAccount(account, group.id, account.groupId || null)}
                                title={group.group_level_name}
                            >
                                <div className="flex flex-wrap gap-1">
                                    {(groupedAccounts[group.id] || []).map(acc => (
                                        <DraggableAccount
                                            key={acc.id}
                                            account={{ ...acc, groupId: group.id }}
                                            className="text-xs px-2 py-1 border rounded bg-gray-100"
                                        />
                                    ))}
                                </div>
                            </DropContainer>
                        ))}
                    </div>

                    {/* Right Column: Accounts List */}
                    <div className="w-1/2 border p-2 overflow-auto">
                        <h2 className="font-bold mb-2">Accounts List</h2>
                        <DropContainer
                            onDrop={(account) => handleMoveAccount(account, null, account.groupId || null)}
                        >
                            {accountsList.map(account => (
                                <DraggableAccount
                                    key={account.id}
                                    account={account}
                                    className="text-xs px-2 py-1 border rounded bg-gray-100 mb-1"
                                />
                            ))}
                        </DropContainer>
                    </div>
                </div>

                {/* Modal for Group Levels */}
                {showGroupModal && (
                    <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
                        <div className="bg-white w-1/3 p-4 rounded shadow-lg max-h-[80vh] overflow-auto">
                            <div className="flex justify-between items-center mb-4">
                                <h2 className="text-lg font-bold">Group Levels</h2>
                                <button onClick={() => setShowGroupModal(false)} className="text-red-500">Close</button>
                            </div>

                            <input
                                type="text"
                                placeholder="Group Level Name"
                                value={groupLevels.group_level_name}
                                onChange={e => setGroupLevels({ ...groupLevels, group_level_name: e.target.value })}
                                className="border p-1 w-full mb-2"
                            />
                            <div className="flex mb-2">
                                <button onClick={handleSaveGroupLevel} className="bg-blue-500 text-white px-2 py-1 mr-1">
                                    {editId ? "Update" : "Add"}
                                </button>
                                {editId && (
                                    <button
                                        onClick={() => { setEditId(null); setGroupLevels({ group_level_name: "" }) }}
                                        className="bg-gray-300 px-2 py-1"
                                    >
                                        Cancel
                                    </button>
                                )}
                            </div>

                            <ul>
                                {allGroupLevels.map(group => (
                                    <li key={group.id} className="flex justify-between items-center border-b py-1">
                                        <span>{group.group_level_name}</span>
                                        <div>
                                            <button onClick={() => handleEdit(group)} className="bg-yellow-400 px-2 py-0.5 mr-1">Edit</button>
                                            <button onClick={() => handleDelete(group.id)} className="bg-red-500 text-white px-2 py-0.5">Delete</button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}
            </div>
        </DndProvider>
    )
}

export default AccountGroupingSettings
