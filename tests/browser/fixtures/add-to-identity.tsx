import {createRoot} from 'react-dom/client';
import {AddToIdentityPopover} from '../../../src/components/AddToIdentityPopover';
createRoot(document.getElementById('root')!).render(<div className="generator-node-toolbar" style={{position:'relative',top:30,left:150,width:100}}><AddToIdentityPopover personas={[]} sourceUrl="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='60'%3E%3C/svg%3E" sourceAssetId="image" onAdd={async()=>{}} onCreate={async(name,role)=>{document.getElementById('result')!.textContent=name+':'+role;}}/></div>);
