import { Abi } from "abitype";

export interface IContractOptions {
  contractType: string;
  contractAddress: string[];
  contractInterface: Abi;
  eventSignatures: string[];
}
